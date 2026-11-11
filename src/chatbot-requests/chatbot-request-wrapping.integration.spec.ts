/**
 * human-intervention / unit 3, slice 3a — wrapping the legacy human flows in
 * `ChatbotRequest` against real PostgreSQL (contract §2.1, §2.3, §2.4, R1, R4,
 * R9, S4):
 *   - creation hooks per flow, in the same transaction as the wrapped row;
 *   - the common `resolve` command per subtype, with the wrapped row's own
 *     version fixed at 1 → 2 (R4);
 *   - the zone fan-out (3 customers, `ZONE_SET_CHANGED` race);
 *   - the §2.1 invariant from both entry points (new command and legacy route);
 *   - concurrent resolves through both entry points: one winner, no deadlock.
 *
 * Every command runs in its own nestjs-cls ALS context and its own interactive
 * transaction on one shared pool, like concurrent HTTP requests.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { integrationPrisma } from '../../test/integration/reset-db';
import type {
  AppAbility,
  AppActions,
  AppSubjects,
} from '../auth/authorization/domain/permission';
import { PrismaDeliveryZoneBotRepository } from '../delivery-zones/infrastructure/prisma-delivery-zone-bot.repository';
import { PrismaDeliveryZoneValidationRepository } from '../delivery-zones/infrastructure/prisma-delivery-zone-validation.repository';
import { DELIVERY_ZONE_TYPE } from '../delivery-zones/domain/delivery-zone-intake.request';
import { APPROVE_DELIVERY_ZONE } from '../delivery-zones/domain/delivery-zone-validation.repository';
import { EXPIRATION_TYPE } from '../human-decisions/domain/expiration-intake.request';
import { PrismaExpirationIntakeRepository } from '../human-decisions/infrastructure/prisma-expiration-intake.repository';
import { PrismaHumanDecisionReviewResolveRepository } from '../human-decisions/infrastructure/prisma-human-decision-review-resolve.repository';
import { PrismaRestockIntakeRepository } from '../human-decisions/infrastructure/prisma-restock-intake.repository';
import { ReceiptUploadService } from '../receipts/application/receipt-upload.service';
import { PrismaReceiptReviewRepository } from '../sales/review/infrastructure/prisma-receipt-review.repository';
import { ReceiptReviewService } from '../sales/review/receipt-review.service';
import type { SalesService } from '../sales/sales.service';
import type { ISaleRepository } from '../sales/domain/sale.repository';
import { OutboxWriterService } from '../shared/outbox/outbox-writer.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import {
  ChatbotRequestCommandsService,
  type ResolveAction,
} from './application/chatbot-request-commands.service';
import { ChatbotRequestWrapper } from './infrastructure/chatbot-request-wrapper';
import { canResolveSubtype } from './domain/resolve-permissions';
import { PrismaChatbotRequestCommandStore } from './infrastructure/prisma-chatbot-request-command.store';
import { WrappedRequestResolver } from './infrastructure/wrapped-request-resolver';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

const DEADLOCK_GUARD_MS = 20_000;

describeIfDb('chatbot request wrapping (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const cls = new ClsService<TenantClsStore>(
    new AsyncLocalStorage<TenantClsStore>(),
  );
  const tenantPrisma = new TenantPrismaService(
    prisma as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
    cls,
  );
  const wrapper = new ChatbotRequestWrapper(tenantPrisma);

  const restockIntake = new PrismaRestockIntakeRepository(
    tenantPrisma,
    wrapper,
  );
  const expirationIntake = new PrismaExpirationIntakeRepository(
    tenantPrisma,
    wrapper,
  );
  const zoneBot = new PrismaDeliveryZoneBotRepository(tenantPrisma, wrapper);
  const decisions = new PrismaHumanDecisionReviewResolveRepository(
    tenantPrisma,
    undefined,
    wrapper,
  );
  const validations = new PrismaDeliveryZoneValidationRepository(
    tenantPrisma,
    wrapper,
  );
  // Only the payment write is faked: it locks and settles the sale like the
  // real one, so the lock order request → receipt → sale is exercised.
  const salesService = {
    addPayment: async (
      saleId: string,
      _actor: string,
      dto: { amountCents: number },
    ) => {
      const db = tenantPrisma.getClient();
      await db.$queryRaw(
        Prisma.sql`SELECT "id" FROM "sales" WHERE "id" = ${saleId} FOR UPDATE`,
      );
      const sale = await db.sale.update({
        where: { id: saleId },
        data: {
          paidCents: { increment: dto.amountCents },
          debtCents: { decrement: dto.amountCents },
          paymentStatus: 'PAID',
        },
        select: { totalCents: true, paidCents: true, debtCents: true },
      });
      return { saleId, ...sale, paymentStatus: 'PAID', paymentIds: [] };
    },
  } as unknown as SalesService;
  const receipts = new ReceiptReviewService(
    new PrismaReceiptReviewRepository(tenantPrisma),
    salesService,
    {
      runInTransaction: <T>(work: () => Promise<T>) =>
        tenantPrisma.runInTransaction(work),
    } as unknown as ISaleRepository,
    tenantPrisma,
    new OutboxWriterService(),
    wrapper,
  );
  const receiptUpload = new ReceiptUploadService(
    tenantPrisma,
    {} as never,
    {} as never,
    {
      find: () => Promise.resolve({ enabled: false, enabledActions: [] }),
    } as never,
    new OutboxWriterService(),
    wrapper,
  );
  const service = new ChatbotRequestCommandsService(
    new PrismaChatbotRequestCommandStore(tenantPrisma),
    new WrappedRequestResolver(
      decisions,
      validations,
      receipts,
      wrapper,
      tenantPrisma,
    ),
  );

  const users = { ana: randomUUID(), luis: randomUUID(), rev: randomUUID() };
  const tenants: string[] = [];

  const inTenant = <T>(tenantId: string, work: () => Promise<T>) =>
    cls.runWith({ tenantId, userId: 'test', isSuperAdmin: false }, work);

  async function newTenant(): Promise<string> {
    const id = randomUUID();
    tenants.push(id);
    await prisma.tenant.create({
      data: { id, name: 'Sucursal Centro', slug: `cr-wrap-${id}` },
    });
    const role = await prisma.role.create({
      data: { tenantId: id, name: `Atiende ${id}` },
    });
    await prisma.tenantMembership.createMany({
      data: Object.values(users).map((userId) => ({
        userId,
        tenantId: id,
        roleId: role.id,
      })),
    });
    return id;
  }

  beforeAll(async () => {
    for (const [name, id] of Object.entries(users)) {
      await prisma.user.create({
        data: { id, email: `${id}@wrap.test`, hashedPassword: 'x', name },
      });
    }
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.user.deleteMany({
      where: { id: { in: Object.values(users) } },
    });
  });

  // -------------------------------------------------------------- helpers

  const code = (error: unknown): string =>
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : 'UNKNOWN';

  const outcome = (promise: Promise<unknown>) =>
    promise.then(
      () => 'OK',
      (error: unknown) => code(error),
    );

  const guarded = <T>(promise: Promise<T>) =>
    Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('possible deadlock: no result')),
          DEADLOCK_GUARD_MS,
        ),
      ),
    ]);

  const requestOf = (where: Record<string, string>) =>
    prisma.chatbotRequest.findFirstOrThrow({ where });

  const eventsOf = (requestId: string) =>
    prisma.chatbotRequestEvent.findMany({
      where: { requestId },
      orderBy: { version: 'asc' },
    });

  const group = (tenantId: string, customerKey: string) =>
    prisma.chatbotCustomerGroup.findUnique({
      where: { tenantId_customerKey: { tenantId, customerKey } },
    });

  const abilityOf = (grants: [AppActions, AppSubjects][]): AppAbility => {
    const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
    for (const [action, subject] of grants) can(action, subject);
    return build();
  };
  const ALL_RESOLVE: [AppActions, AppSubjects][] = [
    ['update', 'HumanDecision'],
    ['validate', 'DeliveryZone'],
    ['update', 'ReceiptEvidence'],
  ];

  /** The new staff command, at the request's current version. */
  async function resolveNew(
    tenantId: string,
    requestId: string,
    action: ResolveAction,
    actor = users.ana,
    ability: AppAbility = abilityOf(ALL_RESOLVE),
  ) {
    const row = await prisma.chatbotRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    return inTenant(tenantId, () =>
      service.execute({
        requestId,
        actorUserId: actor,
        actorCanReassign: false,
        actorCanResolveSubtype: (subtype) =>
          canResolveSubtype(ability, subtype),
        idempotencyKey: randomUUID(),
        expectedVersion: row.version,
        command: { kind: 'resolve', action },
      }),
    );
  }

  const restockAction: ResolveAction = {
    type: 'PROVIDE_RESTOCK_ESTIMATE',
    restockDays: 7,
  };

  async function submitRestock(tenantId: string) {
    const result = await inTenant(tenantId, () =>
      restockIntake.submit({
        sourceRequestId: randomUUID(),
        productId: randomUUID(),
        productName: 'Croquetas 20 kg',
        submittedCredentialId: 'cred',
      }),
    );
    return result.request.id;
  }

  const legacyRestock = (tenantId: string, decisionId: string) =>
    inTenant(tenantId, () =>
      decisions.resolve({
        decisionId,
        expectedVersion: 1,
        resolutionRequestId: randomUUID(),
        action: 'PROVIDE_RESTOCK_ESTIMATE',
        restockDays: 3,
        actorUserId: users.rev,
        actorIsSuperAdmin: false,
      }),
    );

  async function createCustomer(
    tenantId: string,
    phoneCountryCode: string,
    phone: string,
  ) {
    return prisma.customer.create({
      data: { tenantId, firstName: 'Cliente', phoneCountryCode, phone },
    });
  }

  async function submitZone(
    tenantId: string,
    phone: { cc: string; phone: string },
    zipCode = '64000',
  ) {
    const sourceRequestId = randomUUID();
    const result = await inTenant(tenantId, () =>
      zoneBot.submit({
        submittedCredentialId: 'cred',
        request: {
          sourceRequestId,
          originalSourceRequestId: sourceRequestId,
          type: DELIVERY_ZONE_TYPE,
          zipCode,
          state: 'Nuevo León',
          municipality: 'Monterrey',
          neighborhood: 'Centro',
          phoneCountryCode: phone.cc,
          phone: phone.phone,
          conversationRef: `conv-${sourceRequestId}`,
          lastCustomerMessageAt: new Date(),
        },
      }),
    );
    return result.record;
  }

  async function createSale(tenantId: string, customerId: string | null) {
    const sale = await prisma.sale.create({
      data: {
        tenantId,
        userId: users.ana,
        customerId,
        folio: `V-${randomUUID().slice(0, 6)}`,
        status: 'CONFIRMED',
        channel: 'ONLINE',
        totalCents: 10_000,
        paidCents: 0,
        debtCents: 10_000,
        paymentStatus: 'CREDIT',
      },
    });
    return sale;
  }

  async function submitReceipt(tenantId: string, saleId: string) {
    const result = await inTenant(tenantId, () =>
      receiptUpload.attachLegacyUrl({
        saleId,
        mediaUrl: 'https://example.test/comprobante.jpg',
        declaredAmountCents: 10_000,
        declaredDate: null,
        declaredReference: null,
      }),
    );
    return result.receiptId;
  }

  /** §2.1: a request is RESOLVED exactly when its wrapped row is resolved. */
  async function expectInvariant(tenantId: string) {
    const rows = await prisma.$queryRaw<
      {
        id: string;
        subtype: string;
        requestResolved: boolean;
        wrappedResolved: boolean;
      }[]
    >`
      SELECT cr."id", cr."subtype"::text AS "subtype",
             (cr."status" = 'RESOLVED') AS "requestResolved",
             CASE cr."subtype"
               WHEN 'DELIVERY_ZONE' THEN dzr."status" = 'RESOLVED'
               WHEN 'TRANSFER_RECEIPT' THEN re."status" <> 'PENDING'
               ELSE hd."status" = 'RESOLVED' END AS "wrappedResolved"
      FROM "chatbot_requests" cr
      LEFT JOIN "human_decisions" hd ON hd."id" = cr."humanDecisionId"
      LEFT JOIN "delivery_zone_requests" dzr ON dzr."id" = cr."deliveryZoneRequestId"
      LEFT JOIN "receipt_evidences" re ON re."id" = cr."receiptEvidenceId"
      WHERE cr."tenantId" = ${tenantId} AND cr."kind" = 'DECISION'
        AND cr."status" <> 'CANCELLED'`;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect({ id: row.id, resolved: row.requestResolved }).toEqual({
        id: row.id,
        resolved: row.wrappedResolved,
      });
    }
  }

  // ------------------------------------------------------------ creation

  describe('creation hooks (same transaction as the wrapped row)', () => {
    it('wraps a RESTOCK intake: customerless key, CREATED event, group, folio', async () => {
      const tenantId = await newTenant();
      const decisionId = await submitRestock(tenantId);

      const request = await requestOf({ humanDecisionId: decisionId });
      expect(request).toMatchObject({
        tenantId,
        kind: 'DECISION',
        subtype: 'RESTOCK',
        status: 'NEW',
        version: 1,
        folio: 1,
        customerKey: `unknown:${decisionId}`,
        customerId: null,
        ambiguousCustomer: false,
        source: 'WRAP:HUMAN_DECISION',
        sourceRequestId: decisionId,
        summary: 'Stock: Croquetas 20 kg',
      });
      expect(await eventsOf(request.id)).toEqual([
        expect.objectContaining({
          type: 'CREATED',
          actorKind: 'SYSTEM',
          actorId: null,
          toStatus: 'NEW',
          version: 1,
        }),
      ]);
      expect(await group(tenantId, request.customerKey)).toMatchObject({
        openCount: 1,
      });
    });

    it('does not wrap again on an idempotent replay and numbers folios per tenant', async () => {
      const tenantId = await newTenant();
      const sourceRequestId = randomUUID();
      const input = {
        sourceRequestId,
        productId: randomUUID(),
        productName: 'Arena',
        submittedCredentialId: 'cred',
      };
      await inTenant(tenantId, () => restockIntake.submit(input));
      const replay = await inTenant(tenantId, () =>
        restockIntake.submit(input),
      );
      expect(replay.status).toBe('replayed');
      await submitRestock(tenantId);

      const folios = await prisma.chatbotRequest.findMany({
        where: { tenantId },
        orderBy: { folio: 'asc' },
        select: { folio: true },
      });
      expect(folios.map((row) => row.folio)).toEqual([1, 2]);
    });

    it('wraps an EXPIRATION intake', async () => {
      const tenantId = await newTenant();
      const product = await prisma.product.create({
        data: { tenantId, name: 'Pastilla antipulgas' },
      });
      const result = await inTenant(tenantId, () =>
        expirationIntake.submit({
          sourceRequestId: randomUUID(),
          type: EXPIRATION_TYPE,
          productId: product.id,
          variantId: null,
          submittedCredentialId: 'cred',
        }),
      );
      const request = await requestOf({ humanDecisionId: result.request.id });
      expect(request).toMatchObject({
        subtype: 'EXPIRATION',
        status: 'NEW',
        summary: 'Caducidad: Pastilla antipulgas',
      });
    });

    it('rolls the wrapped insert back when the wrapper fails, and the folio with it', async () => {
      const tenantId = await newTenant();
      const failing = new PrismaRestockIntakeRepository(tenantPrisma, {
        wrapHumanDecision: () => Promise.reject(new Error('wrapper down')),
      } as unknown as ChatbotRequestWrapper);
      await expect(
        inTenant(tenantId, () =>
          failing.submit({
            sourceRequestId: randomUUID(),
            productId: randomUUID(),
            productName: 'Arena',
            submittedCredentialId: 'cred',
          }),
        ),
      ).rejects.toThrow('wrapper down');
      expect(await prisma.humanDecision.count({ where: { tenantId } })).toBe(0);
      expect(await prisma.chatbotRequest.count({ where: { tenantId } })).toBe(
        0,
      );

      await submitRestock(tenantId);
      expect((await requestOf({ tenantId })).folio).toBe(1);
    });

    it('leaves no request behind when the wrapped row is rolled back', async () => {
      const tenantId = await newTenant();
      await expect(
        inTenant(tenantId, () =>
          tenantPrisma.runInTransaction(async () => {
            const tx = tenantPrisma.getClient();
            const decision = await tx.humanDecision.create({
              data: {
                tenantId,
                source: 'houndfe-chatbot',
                sourceRequestId: randomUUID(),
                canonicalRequestHash: 'h',
                submittedCredentialId: 'cred',
                branchId: tenantId,
                productId: randomUUID(),
                productName: 'Arena',
              },
            });
            await wrapper.wrapHumanDecision({
              id: decision.id,
              type: 'RESTOCK',
              productId: decision.productId,
              productName: decision.productName,
              variantId: null,
            });
            throw new Error('abort after wrapping');
          }),
        ),
      ).rejects.toThrow('abort after wrapping');
      expect(await prisma.chatbotRequest.count({ where: { tenantId } })).toBe(
        0,
      );
      expect(
        await prisma.chatbotCustomerGroup.count({ where: { tenantId } }),
      ).toBe(0);
    });

    it('wraps a zone requester with its customer, and links only an unambiguous phone (R1)', async () => {
      const tenantId = await newTenant();
      const only = await createCustomer(tenantId, '52', '5512345678');
      const first = await submitZone(tenantId, {
        cc: '52',
        phone: '5215512345678',
      });
      const linked = await requestOf({ deliveryZoneRequestId: first.id });
      expect(linked).toMatchObject({
        subtype: 'DELIVERY_ZONE',
        customerKey: '525512345678',
        customerId: only.id,
        ambiguousCustomer: false,
        phoneCountryCode: '52',
        phone: '5512345678',
        source: 'WRAP:DELIVERY_ZONE_REQUEST',
      });
      expect(linked.whatsappWindowClosesAt).not.toBeNull();

      // A duplicate customer with the same number (stored as 521…) makes it
      // ambiguous: no link, flagged for the staff.
      await createCustomer(tenantId, '521', '5512345678');
      const second = await submitZone(tenantId, {
        cc: '52',
        phone: '5512345678',
      });
      expect(
        await requestOf({ deliveryZoneRequestId: second.id }),
      ).toMatchObject({
        customerKey: '525512345678',
        customerId: null,
        ambiguousCustomer: true,
      });

      const stranger = await submitZone(tenantId, {
        cc: '52',
        phone: '5599998888',
      });
      expect(
        await requestOf({ deliveryZoneRequestId: stranger.id }),
      ).toMatchObject({
        customerKey: '525599998888',
        customerId: null,
        ambiguousCustomer: false,
      });
      expect(await group(tenantId, '525512345678')).toMatchObject({
        openCount: 2,
      });
    });

    it('does not wrap a zone requester born RESOLVED by an existing zone', async () => {
      const tenantId = await newTenant();
      await prisma.deliveryZone.create({
        data: {
          tenantId,
          zipCode: '64000',
          type: 'FREE',
          etaDays: 1,
          approvedById: users.ana,
          approvedByDisplayName: 'ana',
          approvedAt: new Date(),
        },
      });
      const record = await submitZone(tenantId, {
        cc: '52',
        phone: '5512345678',
      });
      expect(record.status).toBe('RESOLVED');
      expect(await prisma.chatbotRequest.count({ where: { tenantId } })).toBe(
        0,
      );
    });

    it('wraps a receipt from the sale customer, or without one', async () => {
      const tenantId = await newTenant();
      const customer = await createCustomer(tenantId, '52', '5512345678');
      const sale = await createSale(tenantId, customer.id);
      const receiptId = await submitReceipt(tenantId, sale.id);
      expect(await requestOf({ receiptEvidenceId: receiptId })).toMatchObject({
        subtype: 'TRANSFER_RECEIPT',
        status: 'NEW',
        customerId: customer.id,
        customerKey: '525512345678',
        summary: `Comprobante de transferencia ${sale.folio}`,
        context: { saleId: sale.id },
      });

      const anonymousSale = await createSale(tenantId, null);
      const anonymousId = await submitReceipt(tenantId, anonymousSale.id);
      expect(await requestOf({ receiptEvidenceId: anonymousId })).toMatchObject(
        {
          customerId: null,
          customerKey: `unknown:${anonymousId}`,
        },
      );
    });
  });

  // ------------------------------------------------------------- resolve

  describe('common resolve per subtype', () => {
    it('RESTOCK: R4 keeps the decision at version 1 until the resolve, then 2', async () => {
      const tenantId = await newTenant();
      const decisionId = await submitRestock(tenantId);
      const request = await requestOf({ humanDecisionId: decisionId });
      const claim = (version: number, kind: 'claim' | 'release') =>
        inTenant(tenantId, () =>
          service.execute({
            requestId: request.id,
            actorUserId: users.ana,
            actorCanReassign: false,
            idempotencyKey: randomUUID(),
            expectedVersion: version,
            command: { kind },
          }),
        );
      await claim(1, 'claim');
      await claim(2, 'release');
      expect(
        await prisma.humanDecision.findUniqueOrThrow({
          where: { id: decisionId },
        }),
      ).toMatchObject({ status: 'PENDING', version: 1 });

      const view = await resolveNew(tenantId, request.id, restockAction);
      expect(view).toMatchObject({ status: 'RESOLVED', version: 4 });
      expect(
        await prisma.humanDecision.findUniqueOrThrow({
          where: { id: decisionId },
        }),
      ).toMatchObject({
        status: 'RESOLVED',
        version: 2,
        resolutionAction: 'PROVIDE_RESTOCK_ESTIMATE',
        restockDays: 7,
        resolvedByActorId: users.ana,
      });
      const resolved = await requestOf({ humanDecisionId: decisionId });
      expect(resolved).toMatchObject({
        status: 'RESOLVED',
        assigneeUserId: users.ana,
        resolvedByActorId: users.ana,
        resolution: { action: 'PROVIDE_RESTOCK_ESTIMATE', restockDays: 7 },
      });
      const events = await eventsOf(request.id);
      expect(events.map((event) => event.type)).toEqual([
        'CREATED',
        'CLAIMED',
        'RELEASED',
        'RESOLVED',
      ]);
      expect(events[3].data).toEqual({ action: 'PROVIDE_RESTOCK_ESTIMATE' });
      expect(await group(tenantId, request.customerKey)).toBeNull();
      await expectInvariant(tenantId);
    });

    it('EXPIRATION: resolves with the normalized text', async () => {
      const tenantId = await newTenant();
      const product = await prisma.product.create({
        data: { tenantId, name: 'Vitaminas' },
      });
      const { request: decision } = await inTenant(tenantId, () =>
        expirationIntake.submit({
          sourceRequestId: randomUUID(),
          type: EXPIRATION_TYPE,
          productId: product.id,
          variantId: null,
          submittedCredentialId: 'cred',
        }),
      );
      const request = await requestOf({ humanDecisionId: decision.id });
      await resolveNew(tenantId, request.id, {
        type: 'PROVIDE_EXPIRATION_TEXT',
        expirationText: 'Diciembre 2026',
      });
      expect(
        await prisma.humanDecision.findUniqueOrThrow({
          where: { id: decision.id },
        }),
      ).toMatchObject({
        status: 'RESOLVED',
        version: 2,
        resolutionAction: 'PROVIDE_EXPIRATION_TEXT',
        expirationText: 'Diciembre 2026',
      });
      await expectInvariant(tenantId);
    });

    it('rejects an action of another subtype without writing anything', async () => {
      const tenantId = await newTenant();
      const decisionId = await submitRestock(tenantId);
      const request = await requestOf({ humanDecisionId: decisionId });
      await expect(
        outcome(
          resolveNew(tenantId, request.id, {
            type: 'CONFIRM_RECEIPT',
            amountCents: 100,
          }),
        ),
      ).resolves.toBe('ACTION_NOT_ALLOWED');
      expect(await requestOf({ id: request.id })).toMatchObject({
        status: 'NEW',
        version: 1,
      });
    });

    it('rolls the common request back when the wrapped use case rejects', async () => {
      const tenantId = await newTenant();
      const sale = await createSale(tenantId, null);
      const receiptId = await submitReceipt(tenantId, sale.id);
      const request = await requestOf({ receiptEvidenceId: receiptId });
      // The sale got paid some other way after the receipt arrived.
      await prisma.sale.update({
        where: { id: sale.id },
        data: { paidCents: 10_000, debtCents: 0, paymentStatus: 'PAID' },
      });
      await expect(
        outcome(
          resolveNew(tenantId, request.id, {
            type: 'CONFIRM_RECEIPT',
            amountCents: 10_000,
          }),
        ),
      ).resolves.toBe('ACTION_NOT_ALLOWED');
      expect(await requestOf({ id: request.id })).toMatchObject({
        status: 'NEW',
        version: 1,
        resolvedAt: null,
      });
      expect(await eventsOf(request.id)).toHaveLength(1);
      expect(
        await prisma.receiptEvidence.findUniqueOrThrow({
          where: { id: receiptId },
        }),
      ).toMatchObject({ status: 'PENDING' });
      expect(await group(tenantId, request.customerKey)).toMatchObject({
        openCount: 1,
      });
    });

    it('TRANSFER_RECEIPT: confirms with the payment, and rejects with the customer reason', async () => {
      const tenantId = await newTenant();
      const customer = await createCustomer(tenantId, '52', '5512345678');
      const sale = await createSale(tenantId, customer.id);
      const confirmed = await submitReceipt(tenantId, sale.id);
      const request = await requestOf({ receiptEvidenceId: confirmed });

      await resolveNew(tenantId, request.id, {
        type: 'CONFIRM_RECEIPT',
        amountCents: 10_000,
      });
      expect(
        await prisma.receiptEvidence.findUniqueOrThrow({
          where: { id: confirmed },
        }),
      ).toMatchObject({ status: 'CONFIRMED', confirmedByUserId: users.ana });
      expect(
        await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } }),
      ).toMatchObject({ paidCents: 10_000, debtCents: 0 });
      expect(await requestOf({ id: request.id })).toMatchObject({
        status: 'RESOLVED',
        resolution: { action: 'CONFIRM_RECEIPT', amountCents: 10_000 },
      });

      const otherSale = await createSale(tenantId, customer.id);
      const rejected = await submitReceipt(tenantId, otherSale.id);
      const otherRequest = await requestOf({ receiptEvidenceId: rejected });
      await resolveNew(tenantId, otherRequest.id, {
        type: 'REJECT_RECEIPT',
        reason: 'monto distinto',
        customerReason: 'El monto no coincide, envíanos otro comprobante.',
      });
      expect(
        await prisma.receiptEvidence.findUniqueOrThrow({
          where: { id: rejected },
        }),
      ).toMatchObject({
        status: 'REJECTED',
        rejectionReason: 'monto distinto',
        customerReason: 'El monto no coincide, envíanos otro comprobante.',
      });
      await expectInvariant(tenantId);
    });
  });

  // ------------------------------------------------- legacy permission gate

  describe('legacy permission per subtype (owner decision)', () => {
    const cashier = () => abilityOf([]);
    const managerNoReceipts = () =>
      abilityOf([
        ['update', 'HumanDecision'],
        ['validate', 'DeliveryZone'],
      ]);

    async function oneOfEach(tenantId: string) {
      const restock = await requestOf({
        humanDecisionId: await submitRestock(tenantId),
      });
      const zone = await requestOf({
        deliveryZoneRequestId: (
          await submitZone(tenantId, { cc: '52', phone: '5511111111' })
        ).id,
      });
      const sale = await createSale(tenantId, null);
      const receipt = await requestOf({
        receiptEvidenceId: await submitReceipt(tenantId, sale.id),
      });
      const { setVersion } = await inTenant(tenantId, () =>
        service.zoneImpact(zone.id),
      );
      const actions: [string, string, ResolveAction][] = [
        ['RESTOCK', restock.id, restockAction],
        [
          'DELIVERY_ZONE',
          zone.id,
          { type: 'REJECT_DELIVERY_ZONE', expectedZoneSetVersion: setVersion },
        ],
        [
          'TRANSFER_RECEIPT',
          receipt.id,
          { type: 'CONFIRM_RECEIPT', amountCents: 10_000 },
        ],
      ];
      return { actions, restock, zone, receipt };
    }

    it('gives a Cashier-like ability 403 on every subtype and writes nothing', async () => {
      const tenantId = await newTenant();
      const { actions } = await oneOfEach(tenantId);
      for (const [, id, action] of actions) {
        await expect(
          outcome(resolveNew(tenantId, id, action, users.ana, cashier())),
        ).resolves.toBe('INSUFFICIENT_PERMISSIONS');
      }
      const rows = await prisma.chatbotRequest.findMany({
        where: { tenantId },
      });
      expect(rows.map((row) => [row.status, row.version])).toEqual(
        rows.map(() => ['NEW', 1]),
      );
      expect(
        await prisma.chatbotRequestEvent.count({
          where: { tenantId, type: { not: 'CREATED' } },
        }),
      ).toBe(0);
      expect(
        await prisma.deliveryZoneValidation.count({
          where: { tenantId, status: 'RESOLVED' },
        }),
      ).toBe(0);
      expect(
        await prisma.receiptEvidence.count({
          where: { tenantId, status: { not: 'PENDING' } },
        }),
      ).toBe(0);
    });

    it('denies receipts to a Manager without update:ReceiptEvidence, allows the rest', async () => {
      const tenantId = await newTenant();
      const { actions } = await oneOfEach(tenantId);
      const [restock, zone, receipt] = actions;

      await expect(
        outcome(
          resolveNew(
            tenantId,
            receipt[1],
            receipt[2],
            users.ana,
            managerNoReceipts(),
          ),
        ),
      ).resolves.toBe('INSUFFICIENT_PERMISSIONS');
      await expect(
        outcome(
          resolveNew(
            tenantId,
            restock[1],
            restock[2],
            users.ana,
            managerNoReceipts(),
          ),
        ),
      ).resolves.toBe('OK');
      await expect(
        outcome(
          resolveNew(
            tenantId,
            zone[1],
            zone[2],
            users.ana,
            managerNoReceipts(),
          ),
        ),
      ).resolves.toBe('OK');
      expect(
        await prisma.receiptEvidence.count({
          where: { tenantId, status: 'PENDING' },
        }),
      ).toBe(1);
    });

    it('resolves a receipt once the Manager also holds update:ReceiptEvidence', async () => {
      const tenantId = await newTenant();
      const { actions } = await oneOfEach(tenantId);
      const receipt = actions[2];
      const full = abilityOf([...ALL_RESOLVE]);
      await expect(
        outcome(resolveNew(tenantId, receipt[1], receipt[2], users.ana, full)),
      ).resolves.toBe('OK');
      expect(await requestOf({ id: receipt[1] })).toMatchObject({
        status: 'RESOLVED',
      });
    });

    it('answers 403 before state: a closed request gives the same 403', async () => {
      const tenantId = await newTenant();
      const decisionId = await submitRestock(tenantId);
      const request = await requestOf({ humanDecisionId: decisionId });
      await resolveNew(tenantId, request.id, restockAction);
      await expect(
        outcome(
          resolveNew(tenantId, request.id, restockAction, users.ana, cashier()),
        ),
      ).resolves.toBe('INSUFFICIENT_PERMISSIONS');
    });
  });

  // Shared by the zone fan-out and the closed-notice specs.
  const impactOf = (tenantId: string, requestId: string) =>
    inTenant(tenantId, () => service.zoneImpact(requestId));

  const approve = (setVersion: number): ResolveAction => ({
    type: 'APPROVE_DELIVERY_ZONE',
    settings: { type: 'SURCHARGE', surchargeCents: 5000, etaDays: 3 },
    expectedZoneSetVersion: setVersion,
  });

  async function openZone(tenantId: string, phones: string[]) {
    const requests: Awaited<ReturnType<typeof requestOf>>[] = [];
    for (const phone of phones) {
      const record = await submitZone(tenantId, { cc: '52', phone });
      requests.push(await requestOf({ deliveryZoneRequestId: record.id }));
    }
    return requests;
  }

  // ------------------------------------------------------------ zone fan-out

  describe('zone fan-out (R9, D15)', () => {
    it('resolves every request of the postal code, refreshes each group, and keeps the others open', async () => {
      const tenantId = await newTenant();
      const [a, b, c] = await openZone(tenantId, [
        '5511111111',
        '5522222222',
        '5533333333',
      ]);
      // A and B also have another open request, so their groups survive.
      for (const key of [a.customerKey, b.customerKey]) {
        await inTenant(tenantId, () =>
          tenantPrisma.runInTransaction(async () => {
            const tx = tenantPrisma.getClient();
            await tx.chatbotRequest.create({
              data: {
                tenantId,
                folio: 100 + (key === a.customerKey ? 0 : 1),
                kind: 'CLARIFICATION',
                subtype: 'UNKNOWN_QUESTION',
                customerKey: key,
                summary: '¿Sirve para gatos?',
                source: 'chatbot',
                sourceRequestId: randomUUID(),
              },
            });
            await tx.chatbotCustomerGroup.update({
              where: { tenantId_customerKey: { tenantId, customerKey: key } },
              data: { openCount: 2 },
            });
          }),
        );
      }

      const impact = await impactOf(tenantId, b.id);
      expect(impact).toEqual({
        validationId: expect.any(String) as string,
        requests: 3,
        customers: 3,
        setVersion: 3,
      });
      const view = await resolveNew(tenantId, b.id, approve(impact.setVersion));
      expect(view).toMatchObject({ status: 'RESOLVED' });

      const all = await prisma.chatbotRequest.findMany({
        where: { id: { in: [a.id, b.id, c.id] } },
        orderBy: { folio: 'asc' },
      });
      expect(all.map((row) => row.status)).toEqual([
        'RESOLVED',
        'RESOLVED',
        'RESOLVED',
      ]);
      const main = all.find((row) => row.id === b.id);
      expect(main?.resolution).toMatchObject({
        action: 'APPROVE_DELIVERY_ZONE',
        zoneType: 'SURCHARGE',
        surchargeCents: 5000,
        etaDays: 3,
      });
      for (const sibling of all.filter((row) => row.id !== b.id)) {
        expect(sibling.resolution).toEqual({
          action: 'SIBLING_RESOLVED',
          viaRequestId: b.id,
        });
        expect(sibling.resolvedByActorId).toBe(users.ana);
        const events = await eventsOf(sibling.id);
        expect(events[events.length - 1]).toMatchObject({
          type: 'RESOLVED',
          toStatus: 'RESOLVED',
          data: { action: 'SIBLING_RESOLVED', viaRequestId: b.id },
        });
      }
      const validation = await prisma.deliveryZoneValidation.findFirstOrThrow({
        where: { tenantId },
      });
      expect(validation).toMatchObject({ status: 'RESOLVED', version: 2 });
      expect(
        await prisma.deliveryZoneRequest.count({
          where: { tenantId, status: 'RESOLVED' },
        }),
      ).toBe(3);
      expect(
        await prisma.deliveryZone.findFirstOrThrow({ where: { tenantId } }),
      ).toMatchObject({ zipCode: '64000', type: 'SURCHARGE', isActive: true });
      expect(await group(tenantId, a.customerKey)).toMatchObject({
        openCount: 1,
      });
      expect(await group(tenantId, b.customerKey)).toMatchObject({
        openCount: 1,
      });
      expect(await group(tenantId, c.customerKey)).toBeNull();
      await expectInvariant(tenantId);
    });

    it('answers 409 ZONE_SET_CHANGED when a requester arrived after the preview, and changes nothing', async () => {
      const tenantId = await newTenant();
      const [a, b] = await openZone(tenantId, ['5511111111', '5522222222']);
      const preview = await impactOf(tenantId, a.id);
      expect(preview).toMatchObject({ requests: 2, customers: 2 });

      await openZone(tenantId, ['5533333333']);

      const error: unknown = await resolveNew(
        tenantId,
        a.id,
        approve(preview.setVersion),
      ).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toMatchObject({
        code: 'ZONE_SET_CHANGED',
        httpStatus: 409,
        current: {
          version: 1,
          status: 'NEW',
          zoneImpact: { requests: 3, customers: 3 },
        },
      });
      const fresh = (
        error as { current: { zoneImpact: { setVersion: number } } }
      ).current.zoneImpact;
      expect(fresh.setVersion).toBeGreaterThan(preview.setVersion);
      for (const request of [a, b]) {
        expect(await requestOf({ id: request.id })).toMatchObject({
          status: 'NEW',
          version: 1,
        });
      }
      expect(
        await prisma.deliveryZoneValidation.findFirstOrThrow({
          where: { tenantId },
        }),
      ).toMatchObject({ status: 'PENDING', version: 1 });

      await resolveNew(tenantId, a.id, approve(fresh.setVersion));
      expect(
        await prisma.chatbotRequest.count({
          where: { tenantId, status: 'RESOLVED' },
        }),
      ).toBe(3);
    });

    it('changes the set version when a requester leaves by cancelling', async () => {
      const tenantId = await newTenant();
      const [a, b] = await openZone(tenantId, ['5511111111', '5522222222']);
      const preview = await impactOf(tenantId, a.id);
      await prisma.chatbotRequest.update({
        where: { id: b.id },
        data: {
          status: 'CANCELLED',
          nextSlaCheckAt: null,
          cancelledAt: new Date(),
          closedAt: new Date(),
          cancelReason: 'CUSTOMER_WITHDREW',
        },
      });
      const after = await impactOf(tenantId, a.id);
      expect(after).toMatchObject({ requests: 1, customers: 1 });
      expect(after.setVersion).toBeGreaterThan(preview.setVersion);
      await expect(
        outcome(resolveNew(tenantId, a.id, approve(preview.setVersion))),
      ).resolves.toBe('ZONE_SET_CHANGED');
    });

    it('two staff resolve two siblings at once: one decision, one winner, no deadlock', async () => {
      const tenantId = await newTenant();
      const [a, b] = await openZone(tenantId, ['5511111111', '5522222222']);
      const { setVersion } = await impactOf(tenantId, a.id);
      const results = await guarded(
        Promise.all([
          outcome(resolveNew(tenantId, a.id, approve(setVersion), users.ana)),
          outcome(resolveNew(tenantId, b.id, approve(setVersion), users.luis)),
        ]),
      );
      expect(results.filter((r) => r === 'OK')).toHaveLength(1);
      expect(results.filter((r) => r === 'REQUEST_CLOSED')).toHaveLength(1);
      expect(
        await prisma.chatbotRequestEvent.count({
          where: { tenantId, type: 'RESOLVED' },
        }),
      ).toBe(2);
      expect(
        await prisma.deliveryZoneValidation.findFirstOrThrow({
          where: { tenantId },
        }),
      ).toMatchObject({ status: 'RESOLVED', version: 2 });
      await expectInvariant(tenantId);
    });
  });

  // ----------------------------------------------------- §2.1 both entry points

  describe('the §2.1 invariant from both entry points', () => {
    it('RESTOCK: the legacy route closes the wrapping request in the same transaction', async () => {
      const tenantId = await newTenant();
      const decisionId = await submitRestock(tenantId);
      const request = await requestOf({ humanDecisionId: decisionId });
      await legacyRestock(tenantId, decisionId);

      expect(await requestOf({ id: request.id })).toMatchObject({
        status: 'RESOLVED',
        version: 2,
        assigneeUserId: users.rev,
        resolvedByActorId: users.rev,
        resolution: {
          action: 'PROVIDE_RESTOCK_ESTIMATE',
          via: 'LEGACY_ROUTE',
        },
      });
      const events = await eventsOf(request.id);
      expect(events[1]).toMatchObject({
        type: 'RESOLVED',
        data: { action: 'PROVIDE_RESTOCK_ESTIMATE', via: 'LEGACY_ROUTE' },
      });
      expect(await group(tenantId, request.customerKey)).toBeNull();
      await expectInvariant(tenantId);
      // And the new command now answers that it is closed.
      await expect(
        outcome(resolveNew(tenantId, request.id, restockAction)),
      ).resolves.toBe('REQUEST_CLOSED');
    });

    it('RESTOCK: after the new command, the old route answers ALREADY_RESOLVED and changes nothing', async () => {
      const tenantId = await newTenant();
      const decisionId = await submitRestock(tenantId);
      const request = await requestOf({ humanDecisionId: decisionId });
      await resolveNew(tenantId, request.id, restockAction);
      await expect(outcome(legacyRestock(tenantId, decisionId))).resolves.toBe(
        'ALREADY_RESOLVED',
      );
      expect(await eventsOf(request.id)).toHaveLength(2);
      await expectInvariant(tenantId);
    });

    it('RESTOCK: an exact legacy replay writes nothing to the common request', async () => {
      const tenantId = await newTenant();
      const decisionId = await submitRestock(tenantId);
      const request = await requestOf({ humanDecisionId: decisionId });
      // The decision was resolved behind the request's back (a row wrapped
      // late, or drift). A replay must report it and leave the request alone.
      const resolutionRequestId = randomUUID();
      await prisma.humanDecision.update({
        where: { id: decisionId },
        data: {
          status: 'RESOLVED',
          version: 2,
          resolutionAction: 'PROVIDE_RESTOCK_ESTIMATE',
          restockDays: 3,
          resolutionRequestId,
          resolvedAt: new Date(),
          resolvedById: users.rev,
          resolvedByActorId: users.rev,
          resolvedByDisplayName: 'rev',
        },
      });
      const before = await eventsOf(request.id);

      const result = await inTenant(tenantId, () =>
        decisions.resolve({
          decisionId,
          expectedVersion: 1,
          resolutionRequestId,
          action: 'PROVIDE_RESTOCK_ESTIMATE',
          restockDays: 3,
          actorUserId: users.rev,
          actorIsSuperAdmin: false,
        }),
      );
      expect(result.status).toBe('replayed');
      expect(await eventsOf(request.id)).toEqual(before);
      expect(await requestOf({ id: request.id })).toMatchObject({
        status: 'NEW',
        version: 1,
      });
      expect(await group(tenantId, request.customerKey)).toMatchObject({
        openCount: 1,
      });
    });

    // Unit 6 (§5.1): «el cliente canceló o se resolvió solo → quien la atendía».
    describe('closed without the assignee: notice to who was attending it', () => {
      const closedNotices = async (tenantId: string) =>
        (
          await prisma.outboxEvent.findMany({
            where: {
              tenantId,
              eventType: 'chatbot_request.notify',
              payload: { path: ['type'], equals: 'REQUEST_CANCELLED' },
            },
            orderBy: { createdAt: 'asc' },
          })
        ).map(
          (row) =>
            row.payload as {
              recipientUserId: string;
              actorUserId?: string;
              cause: string;
              requestId: string;
            },
        );

      const claim = async (
        tenantId: string,
        requestId: string,
        actor: string,
      ) => {
        const row = await prisma.chatbotRequest.findUniqueOrThrow({
          where: { id: requestId },
        });
        return inTenant(tenantId, () =>
          service.execute({
            requestId,
            actorUserId: actor,
            actorCanReassign: true,
            idempotencyKey: randomUUID(),
            expectedVersion: row.version,
            command: { kind: 'claim' },
          }),
        );
      };

      it('a sibling closed by the zone fan-out tells its assignee (SIBLING_RESOLVED), not the actor', async () => {
        const tenantId = await newTenant();
        const [a, b, c] = await openZone(tenantId, [
          '5511111111',
          '5522222222',
          '5533333333',
        ]);
        await claim(tenantId, a.id, users.luis);
        await claim(tenantId, c.id, users.rev);

        const impact = await impactOf(tenantId, b.id);
        await resolveNew(tenantId, b.id, approve(impact.setVersion), users.ana);

        const notices = await closedNotices(tenantId);
        expect(
          notices.map((n) => [n.recipientUserId, n.cause, n.requestId]).sort(),
        ).toEqual(
          [
            [users.luis, 'SIBLING_RESOLVED', a.id],
            [users.rev, 'SIBLING_RESOLVED', c.id],
          ].sort(),
        );
        // b was nobody's: ana's own resolve tells nobody.
        expect(notices.some((n) => n.recipientUserId === users.ana)).toBe(
          false,
        );
      });

      it('a staff resolve of a request someone else holds is refused, so nobody is told', async () => {
        const tenantId = await newTenant();
        const decisionId = await submitRestock(tenantId);
        const request = await requestOf({ humanDecisionId: decisionId });
        await claim(tenantId, request.id, users.luis);

        // The state machine never lets the common resolve take over someone
        // else's request (REQUEST_CLAIMED_BY_OTHER); only the legacy routes
        // and the zone fan-out close a request under its assignee.
        await expect(
          outcome(
            inTenant(tenantId, () =>
              service.execute({
                requestId: request.id,
                actorUserId: users.ana,
                actorCanReassign: true,
                actorCanResolveSubtype: () => true,
                idempotencyKey: randomUUID(),
                expectedVersion: 2,
                command: { kind: 'resolve', action: restockAction },
              }),
            ),
          ),
        ).resolves.toBe('REQUEST_CLAIMED_BY_OTHER');
        expect(await closedNotices(tenantId)).toHaveLength(0);
      });

      it('a legacy-route resolve by someone else tells the assignee; by the assignee, nobody', async () => {
        const tenantId = await newTenant();
        const first = await submitRestock(tenantId);
        const second = await submitRestock(tenantId);
        const held = await requestOf({ humanDecisionId: first });
        const own = await requestOf({ humanDecisionId: second });
        await claim(tenantId, held.id, users.luis);
        await claim(tenantId, own.id, users.rev);

        await legacyRestock(tenantId, first); // resolved by rev, held by luis
        await legacyRestock(tenantId, second); // resolved by rev, held by rev

        expect(await closedNotices(tenantId)).toMatchObject([
          {
            recipientUserId: users.luis,
            actorUserId: users.rev,
            cause: 'RESOLVED_BY_OTHER',
            requestId: held.id,
          },
        ]);
      });

      it('a legacy zone resolve tells each assigned wrapper except the resolver', async () => {
        const tenantId = await newTenant();
        const record = await submitZone(tenantId, {
          cc: '52',
          phone: '5511111111',
        });
        await submitZone(tenantId, { cc: '52', phone: '5522222222' });
        const rows = await prisma.chatbotRequest.findMany({
          where: { tenantId },
        });
        await claim(tenantId, rows[0].id, users.luis);
        await claim(tenantId, rows[1].id, users.rev);

        await inTenant(tenantId, () =>
          validations.resolve({
            validationId: record.validationId as string,
            expectedVersion: 1,
            resolutionRequestId: randomUUID(),
            action: APPROVE_DELIVERY_ZONE,
            settings: { type: 'FREE', surchargeCents: null, etaDays: 2 },
            actorUserId: users.rev,
            actorIsSuperAdmin: false,
          }),
        );

        // rev resolved it, so only luis is told.
        expect(await closedNotices(tenantId)).toMatchObject([
          { recipientUserId: users.luis, cause: 'RESOLVED_BY_OTHER' },
        ]);
      });
    });

    it('DELIVERY_ZONE: the legacy validation resolve closes every wrapping request', async () => {
      const tenantId = await newTenant();
      const record = await submitZone(tenantId, {
        cc: '52',
        phone: '5511111111',
      });
      await submitZone(tenantId, { cc: '52', phone: '5522222222' });
      await inTenant(tenantId, () =>
        validations.resolve({
          validationId: record.validationId as string,
          expectedVersion: 1,
          resolutionRequestId: randomUUID(),
          action: APPROVE_DELIVERY_ZONE,
          settings: { type: 'FREE', surchargeCents: null, etaDays: 2 },
          actorUserId: users.rev,
          actorIsSuperAdmin: false,
        }),
      );
      const requests = await prisma.chatbotRequest.findMany({
        where: { tenantId },
      });
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request).toMatchObject({
          status: 'RESOLVED',
          resolvedByActorId: users.rev,
          resolution: {
            action: APPROVE_DELIVERY_ZONE,
            via: 'LEGACY_ROUTE',
            zoneType: 'FREE',
          },
        });
        expect(await group(tenantId, request.customerKey)).toBeNull();
      }
      await expectInvariant(tenantId);
      await expect(
        outcome(resolveNew(tenantId, requests[0].id, restockAction)),
      ).resolves.toBe('REQUEST_CLOSED');
    });

    it('TRANSFER_RECEIPT: the legacy confirm and reject close the wrapping request', async () => {
      const tenantId = await newTenant();
      const sale = await createSale(tenantId, null);
      const confirmed = await submitReceipt(tenantId, sale.id);
      await inTenant(tenantId, () =>
        receipts.confirm(
          sale.id,
          confirmed,
          users.rev,
          { amountCents: 10_000 },
          randomUUID(),
        ),
      );
      expect(await requestOf({ receiptEvidenceId: confirmed })).toMatchObject({
        status: 'RESOLVED',
        resolvedByActorId: users.rev,
        resolution: { action: 'CONFIRM_RECEIPT', via: 'LEGACY_ROUTE' },
      });

      const otherSale = await createSale(tenantId, null);
      const rejected = await submitReceipt(tenantId, otherSale.id);
      await inTenant(tenantId, () =>
        receipts.reject(otherSale.id, rejected, users.rev, {
          reason: 'ilegible',
        }),
      );
      expect(await requestOf({ receiptEvidenceId: rejected })).toMatchObject({
        status: 'RESOLVED',
        resolution: { action: 'REJECT_RECEIPT', via: 'LEGACY_ROUTE' },
      });
      await expectInvariant(tenantId);
    });

    it('TRANSFER_RECEIPT: a legacy reviewer with an empty name does not break confirm or reject', async () => {
      const tenantId = await newTenant();
      const nameless = randomUUID();
      await prisma.user.create({
        data: {
          id: nameless,
          email: `caja.noche-${nameless}@wrap.test`,
          hashedPassword: 'x',
          name: '',
        },
      });
      try {
        const sale = await createSale(tenantId, null);
        const confirmed = await submitReceipt(tenantId, sale.id);
        await inTenant(tenantId, () =>
          receipts.confirm(
            sale.id,
            confirmed,
            nameless,
            { amountCents: 10_000 },
            randomUUID(),
          ),
        );
        const otherSale = await createSale(tenantId, null);
        const rejected = await submitReceipt(tenantId, otherSale.id);
        await inTenant(tenantId, () =>
          receipts.reject(otherSale.id, rejected, nameless, {
            reason: 'ilegible',
          }),
        );

        for (const receiptEvidenceId of [confirmed, rejected]) {
          const request = await requestOf({ receiptEvidenceId });
          expect(request).toMatchObject({
            status: 'RESOLVED',
            resolvedByActorId: nameless,
            resolvedByDisplayName: 'caja.noche-' + nameless,
          });
          const events = await eventsOf(request.id);
          expect(events[events.length - 1]).toMatchObject({
            type: 'RESOLVED',
            actorKind: 'USER',
            actorDisplayName: 'caja.noche-' + nameless,
          });
        }
      } finally {
        await prisma.tenant.delete({ where: { id: tenantId } });
        await prisma.user.delete({ where: { id: nameless } });
        tenants.splice(tenants.indexOf(tenantId), 1);
      }
    });

    it('does not close the request when the legacy resolve fails', async () => {
      const tenantId = await newTenant();
      const decisionId = await submitRestock(tenantId);
      await expect(
        outcome(
          inTenant(tenantId, () =>
            decisions.resolve({
              decisionId,
              expectedVersion: 9,
              resolutionRequestId: randomUUID(),
              action: 'PROVIDE_RESTOCK_ESTIMATE',
              restockDays: 3,
              actorUserId: users.rev,
              actorIsSuperAdmin: false,
            }),
          ),
        ),
      ).resolves.toBe('VERSION_CONFLICT');
      expect(await requestOf({ humanDecisionId: decisionId })).toMatchObject({
        status: 'NEW',
        version: 1,
      });
    });
  });

  // ---------------------------------------------------------------- races

  describe('concurrent resolves through both entry points', () => {
    const ROUNDS = 5;

    it('RESTOCK: new command vs legacy route, one winner, no deadlock', async () => {
      const tenantId = await newTenant();
      for (let round = 0; round < ROUNDS; round += 1) {
        const decisionId = await submitRestock(tenantId);
        const request = await requestOf({ humanDecisionId: decisionId });
        const results = await guarded(
          Promise.all([
            outcome(resolveNew(tenantId, request.id, restockAction)),
            outcome(legacyRestock(tenantId, decisionId)),
          ]),
        );
        expect(results.filter((r) => r === 'OK')).toHaveLength(1);
        expect(['REQUEST_CLOSED', 'ALREADY_RESOLVED']).toContain(
          results.find((r) => r !== 'OK'),
        );
        const events = await eventsOf(request.id);
        expect(events.filter((e) => e.type === 'RESOLVED')).toHaveLength(1);
      }
      await expectInvariant(tenantId);
    });

    it('DELIVERY_ZONE: new command vs legacy route, one winner, no deadlock', async () => {
      const tenantId = await newTenant();
      for (let round = 0; round < ROUNDS; round += 1) {
        const zipCode = `6400${round}`;
        const record = await submitZone(
          tenantId,
          { cc: '52', phone: `55111111${round}0` },
          zipCode,
        );
        await submitZone(
          tenantId,
          { cc: '52', phone: `55222222${round}0` },
          zipCode,
        );
        const request = await requestOf({ deliveryZoneRequestId: record.id });
        const { setVersion } = await inTenant(tenantId, () =>
          service.zoneImpact(request.id),
        );
        const results = await guarded(
          Promise.all([
            outcome(
              resolveNew(tenantId, request.id, {
                type: 'REJECT_DELIVERY_ZONE',
                expectedZoneSetVersion: setVersion,
              }),
            ),
            outcome(
              inTenant(tenantId, () =>
                validations.resolve({
                  validationId: record.validationId as string,
                  expectedVersion: 1,
                  resolutionRequestId: randomUUID(),
                  action: 'REJECT_DELIVERY_ZONE',
                  actorUserId: users.rev,
                  actorIsSuperAdmin: false,
                }),
              ),
            ),
          ]),
        );
        expect(results.filter((r) => r === 'OK')).toHaveLength(1);
        expect(['REQUEST_CLOSED', 'ALREADY_RESOLVED']).toContain(
          results.find((r) => r !== 'OK'),
        );
      }
      expect(
        await prisma.chatbotRequest.count({
          where: { tenantId, status: { not: 'RESOLVED' } },
        }),
      ).toBe(0);
      await expectInvariant(tenantId);
    });

    it('TRANSFER_RECEIPT: new command vs legacy confirm, one winner, one payment, no deadlock', async () => {
      const tenantId = await newTenant();
      for (let round = 0; round < ROUNDS; round += 1) {
        const sale = await createSale(tenantId, null);
        const receiptId = await submitReceipt(tenantId, sale.id);
        const request = await requestOf({ receiptEvidenceId: receiptId });
        const results = await guarded(
          Promise.all([
            outcome(
              resolveNew(tenantId, request.id, {
                type: 'CONFIRM_RECEIPT',
                amountCents: 10_000,
              }),
            ),
            outcome(
              inTenant(tenantId, () =>
                receipts.confirm(
                  sale.id,
                  receiptId,
                  users.rev,
                  { amountCents: 10_000 },
                  randomUUID(),
                ),
              ),
            ),
          ]),
        );
        expect(results.filter((r) => r === 'OK')).toHaveLength(1);
        expect(['REQUEST_CLOSED', 'RECEIPT_NOT_ACTIONABLE']).toContain(
          results.find((r) => r !== 'OK'),
        );
        expect(
          (await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } }))
            .paidCents,
        ).toBe(10_000);
      }
      await expectInvariant(tenantId);
    });

    it('20 parallel resolves over mixed flows finish without a deadlock', async () => {
      const tenantId = await newTenant();
      const jobs: Promise<string>[] = [];
      for (let i = 0; i < 10; i += 1) {
        const decisionId = await submitRestock(tenantId);
        const request = await requestOf({ humanDecisionId: decisionId });
        jobs.push(outcome(resolveNew(tenantId, request.id, restockAction)));
        jobs.push(outcome(legacyRestock(tenantId, decisionId)));
      }
      const results = await guarded(Promise.all(jobs));
      expect(results.filter((r) => r === 'OK')).toHaveLength(10);
      expect(
        results.filter(
          (r) =>
            r !== 'OK' && r !== 'REQUEST_CLOSED' && r !== 'ALREADY_RESOLVED',
        ),
      ).toEqual([]);
      await expectInvariant(tenantId);
    });
  });
});
