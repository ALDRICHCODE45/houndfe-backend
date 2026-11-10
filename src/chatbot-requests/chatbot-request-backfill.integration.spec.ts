/**
 * human-intervention / unit 3, slice 3b — the one-time backfill of the legacy
 * human flows into `ChatbotRequest` against real PostgreSQL (contract §2.4,
 * §2.3, R1, R9; lock-order rules of docs/chatbot-requests-model.md):
 *   - PENDING rows become NEW requests, rows RESOLVED in the last 7 days become
 *     RESOLVED ones (resolvedAt copied), older resolved rows are left alone;
 *   - dry run writes nothing; the second run has nothing to create;
 *   - the same folio, customerKey, R1 ambiguity flag and group refresh as the
 *     3a hooks, with unique folios and consistent customer groups;
 *   - the §2.1 invariant check (`checkInvariant`);
 *   - races: a second backfill, the 3a creation hooks, and the legacy resolve
 *     routes, all running while the backfill applies.
 *
 * The legacy rows are seeded straight into the tables, as they exist in
 * production before the 3a code ran: no wrapper, no hook.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { ClsService } from 'nestjs-cls';
import { integrationPrisma } from '../../test/integration/reset-db';
import { PrismaDeliveryZoneBotRepository } from '../delivery-zones/infrastructure/prisma-delivery-zone-bot.repository';
import { PrismaDeliveryZoneValidationRepository } from '../delivery-zones/infrastructure/prisma-delivery-zone-validation.repository';
import { DELIVERY_ZONE_TYPE } from '../delivery-zones/domain/delivery-zone-intake.request';
import { APPROVE_DELIVERY_ZONE } from '../delivery-zones/domain/delivery-zone-validation.repository';
import { PrismaHumanDecisionReviewResolveRepository } from '../human-decisions/infrastructure/prisma-human-decision-review-resolve.repository';
import { PrismaRestockIntakeRepository } from '../human-decisions/infrastructure/prisma-restock-intake.repository';
import { ReceiptUploadService } from '../receipts/application/receipt-upload.service';
import { OutboxWriterService } from '../shared/outbox/outbox-writer.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import { ChatbotRequestWrapper } from './infrastructure/chatbot-request-wrapper';
import {
  checkInvariant,
  runBackfill,
  type BackfillReport,
  type SubtypeCounts,
  type TenantBackfillReport,
} from './infrastructure/chatbot-request-backfill';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

const DEADLOCK_GUARD_MS = 25_000;
const DAY_MS = 24 * 60 * 60 * 1000;

describeIfDb('chatbot request backfill (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const cls = new ClsService<TenantClsStore>(
    new AsyncLocalStorage<TenantClsStore>(),
  );
  const tenantPrisma = new TenantPrismaService(
    prisma as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
    cls,
  );
  // The 3a hooks, to race the backfill against and to plant a wrapper.
  const wrapper = new ChatbotRequestWrapper(tenantPrisma);
  const restockIntake = new PrismaRestockIntakeRepository(
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

  const reviewer = randomUUID();
  const tenants: string[] = [];

  const inTenant = <T>(tenantId: string, work: () => Promise<T>) =>
    cls.runWith({ tenantId, userId: 'test', isSuperAdmin: false }, work);

  async function newTenant(): Promise<string> {
    const id = randomUUID();
    tenants.push(id);
    await prisma.tenant.create({
      data: { id, name: 'Sucursal Centro', slug: `cr-backfill-${id}` },
    });
    // The legacy resolve routes require the reviewer to be a member.
    const role = await prisma.role.create({
      data: { tenantId: id, name: `Atiende ${id}` },
    });
    await prisma.tenantMembership.create({
      data: { userId: reviewer, tenantId: id, roleId: role.id },
    });
    return id;
  }

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: reviewer,
        email: `${reviewer}@backfill.test`,
        hashedPassword: 'x',
        name: 'Revisora',
      },
    });
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.user.deleteMany({ where: { id: reviewer } });
  });

  // ---------------------------------------------------------------- helpers

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

  const containing = (value: Record<string, unknown>): unknown =>
    expect.objectContaining(value);

  const ago = (days: number, now = new Date()) =>
    new Date(now.getTime() - days * DAY_MS);

  async function seedDecision(
    tenantId: string,
    input: {
      type: 'RESTOCK' | 'EXPIRATION';
      resolvedDaysAgo?: number;
      createdDaysAgo?: number;
    },
  ): Promise<string> {
    const resolved = input.resolvedDaysAgo !== undefined;
    const row = await prisma.humanDecision.create({
      data: {
        tenantId,
        source: 'houndfe-chatbot',
        sourceRequestId: randomUUID(),
        type: input.type,
        canonicalRequestHash: 'hash',
        submittedCredentialId: 'cred',
        branchId: 'branch',
        productId: randomUUID(),
        productName: 'Croquetas 20 kg',
        productUnit: input.type === 'EXPIRATION' ? 'kg' : null,
        createdAt: ago(
          input.createdDaysAgo ?? (input.resolvedDaysAgo ?? 0) + 1,
        ),
        ...(resolved
          ? {
              status: 'RESOLVED',
              version: 2,
              resolutionAction:
                input.type === 'RESTOCK'
                  ? 'PROVIDE_RESTOCK_ESTIMATE'
                  : 'PROVIDE_EXPIRATION_TEXT',
              restockDays: input.type === 'RESTOCK' ? 7 : null,
              expirationText: input.type === 'EXPIRATION' ? 'Junio 2027' : null,
              resolutionRequestId: randomUUID(),
              resolvedAt: ago(input.resolvedDaysAgo as number),
              resolvedByActorId: reviewer,
              resolvedByDisplayName: 'Revisora',
            }
          : {}),
      },
    });
    return row.id;
  }

  async function seedValidation(
    tenantId: string,
    zipCode: string,
    resolvedDaysAgo?: number,
  ): Promise<string> {
    const row = await prisma.deliveryZoneValidation.create({
      data: {
        tenantId,
        zipCode,
        state: 'Nuevo León',
        municipality: 'Monterrey',
        neighborhood: 'Centro',
        ...(resolvedDaysAgo !== undefined
          ? {
              status: 'RESOLVED',
              version: 2,
              resolutionAction: 'APPROVE_DELIVERY_ZONE',
              zoneType: 'FREE',
              etaDays: 2,
              resolutionRequestId: randomUUID(),
              resolvedAt: ago(resolvedDaysAgo),
              resolvedByActorId: reviewer,
              resolvedByDisplayName: 'Revisora',
            }
          : {}),
      },
    });
    return row.id;
  }

  async function seedZoneRequest(
    tenantId: string,
    input: {
      validationId: string | null;
      zipCode: string;
      phone: string;
      cc?: string;
      resolvedDaysAgo?: number;
      existingZone?: boolean;
    },
  ): Promise<string> {
    const resolved = input.resolvedDaysAgo !== undefined;
    const row = await prisma.deliveryZoneRequest.create({
      data: {
        tenantId,
        source: 'houndfe-chatbot',
        sourceRequestId: randomUUID(),
        canonicalRequestHash: 'hash',
        submittedCredentialId: 'cred',
        validationId: input.validationId,
        zipCode: input.zipCode,
        state: 'Nuevo León',
        municipality: 'Monterrey',
        neighborhood: 'Centro',
        customerPhoneCountryCode: input.cc ?? '52',
        customerPhone: input.phone,
        conversationRef: `conv-${randomUUID()}`,
        lastCustomerMessageAt: ago(1),
        createdAt: ago((input.resolvedDaysAgo ?? 0) + 1),
        ...(resolved
          ? {
              status: 'RESOLVED',
              version: 2,
              resolutionSource: input.existingZone
                ? 'EXISTING_ZONE'
                : 'VALIDATION',
              zoneType: 'FREE',
              etaDays: 2,
              resolvedAt: ago(input.resolvedDaysAgo as number),
            }
          : {}),
      },
    });
    return row.id;
  }

  async function seedSale(tenantId: string, customerId: string | null) {
    return prisma.sale.create({
      data: {
        tenantId,
        userId: reviewer,
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
  }

  async function seedReceipt(
    tenantId: string,
    saleId: string,
    input: {
      status: 'PENDING' | 'CONFIRMED' | 'REJECTED';
      confirmedDaysAgo?: number;
      createdDaysAgo?: number;
    },
  ): Promise<string> {
    const row = await prisma.receiptEvidence.create({
      data: {
        tenantId,
        saleId,
        mediaUrl: 'https://example.test/comprobante.jpg',
        declaredAmountCents: 10_000,
        status: input.status,
        createdAt: ago(input.createdDaysAgo ?? 1),
        ...(input.status === 'CONFIRMED'
          ? {
              confirmedByUserId: reviewer,
              confirmedAt: ago(input.confirmedDaysAgo ?? 1),
            }
          : {}),
        ...(input.status === 'REJECTED'
          ? { rejectionReason: 'ilegible', customerReason: 'ilegible' }
          : {}),
      },
    });
    return row.id;
  }

  async function createCustomer(
    tenantId: string,
    phoneCountryCode: string,
    phone: string,
  ) {
    return prisma.customer.create({
      data: { tenantId, firstName: 'Cliente', phoneCountryCode, phone },
    });
  }

  interface Fixture {
    tenantId: string;
    restockOpen: string[];
    expirationOpen: string;
    restockRecent: string;
    expirationRecent: string;
    restockOld: string;
    restockWrapped: string;
    validationOpen: string;
    zoneOpen: { plain: string; linked: string; ambiguous: string };
    linkedCustomerId: string;
    zoneRecent: string;
    zoneOld: string;
    zoneExisting: string;
    receiptOpen: string;
    receiptOpenNoCustomer: string;
    receiptRecent: string;
    receiptOld: string;
    receiptRejected: string;
    receiptRejectedOld: string;
    receiptCustomerId: string;
  }

  /** Legacy rows as they exist before the 3a code: no wrapper anywhere. */
  async function seedLegacy(): Promise<Fixture> {
    const tenantId = await newTenant();
    const restockOpen = [
      await seedDecision(tenantId, { type: 'RESTOCK', createdDaysAgo: 5 }),
      await seedDecision(tenantId, { type: 'RESTOCK', createdDaysAgo: 40 }),
    ];
    const expirationOpen = await seedDecision(tenantId, {
      type: 'EXPIRATION',
      createdDaysAgo: 2,
    });
    const restockRecent = await seedDecision(tenantId, {
      type: 'RESTOCK',
      resolvedDaysAgo: 2,
    });
    const expirationRecent = await seedDecision(tenantId, {
      type: 'EXPIRATION',
      resolvedDaysAgo: 6,
    });
    const restockOld = await seedDecision(tenantId, {
      type: 'RESTOCK',
      resolvedDaysAgo: 8,
    });
    // This one already has its wrapper (as if a 3a hook created it).
    const restockWrapped = await seedDecision(tenantId, {
      type: 'RESTOCK',
      createdDaysAgo: 1,
    });
    await inTenant(tenantId, () =>
      tenantPrisma.runInTransaction(() =>
        wrapper.wrapHumanDecision({
          id: restockWrapped,
          type: 'RESTOCK',
          productId: randomUUID(),
          productName: 'Croquetas 20 kg',
          variantId: null,
        }),
      ),
    );

    const linked = await createCustomer(tenantId, '52', '5522222222');
    await createCustomer(tenantId, '52', '5533333333');
    await createCustomer(tenantId, '521', '5533333333');
    const validationOpen = await seedValidation(tenantId, '64000');
    const zoneOpen = {
      plain: await seedZoneRequest(tenantId, {
        validationId: validationOpen,
        zipCode: '64000',
        phone: '5511111111',
      }),
      linked: await seedZoneRequest(tenantId, {
        validationId: validationOpen,
        zipCode: '64000',
        phone: '5522222222',
      }),
      ambiguous: await seedZoneRequest(tenantId, {
        validationId: validationOpen,
        zipCode: '64000',
        phone: '5533333333',
      }),
    };
    const validationRecent = await seedValidation(tenantId, '66000', 3);
    const zoneRecent = await seedZoneRequest(tenantId, {
      validationId: validationRecent,
      zipCode: '66000',
      phone: '5544444444',
      resolvedDaysAgo: 3,
    });
    const validationOld = await seedValidation(tenantId, '67000', 8);
    const zoneOld = await seedZoneRequest(tenantId, {
      validationId: validationOld,
      zipCode: '67000',
      phone: '5555555555',
      resolvedDaysAgo: 8,
    });
    // Born resolved by an existing zone: never waited for a human.
    const zoneExisting = await seedZoneRequest(tenantId, {
      validationId: null,
      zipCode: '68000',
      phone: '5566666666',
      resolvedDaysAgo: 1,
      existingZone: true,
    });

    const receiptCustomer = await createCustomer(tenantId, '52', '5577777777');
    const saleWithCustomer = await seedSale(tenantId, receiptCustomer.id);
    const saleAnonymous = await seedSale(tenantId, null);
    const receiptOpen = await seedReceipt(tenantId, saleWithCustomer.id, {
      status: 'PENDING',
    });
    const receiptOpenNoCustomer = await seedReceipt(
      tenantId,
      saleAnonymous.id,
      {
        status: 'PENDING',
      },
    );
    const receiptRecent = await seedReceipt(tenantId, saleWithCustomer.id, {
      status: 'CONFIRMED',
      confirmedDaysAgo: 3,
    });
    const receiptOld = await seedReceipt(tenantId, saleWithCustomer.id, {
      status: 'CONFIRMED',
      confirmedDaysAgo: 8,
      createdDaysAgo: 9,
    });
    // Rejected receipts keep no resolution date (markRejected writes none).
    const receiptRejected = await seedReceipt(tenantId, saleWithCustomer.id, {
      status: 'REJECTED',
      createdDaysAgo: 2,
    });
    const receiptRejectedOld = await seedReceipt(
      tenantId,
      saleWithCustomer.id,
      {
        status: 'REJECTED',
        createdDaysAgo: 30,
      },
    );

    return {
      tenantId,
      restockOpen,
      expirationOpen,
      restockRecent,
      expirationRecent,
      restockOld,
      restockWrapped,
      validationOpen,
      zoneOpen,
      linkedCustomerId: linked.id,
      zoneRecent,
      zoneOld,
      zoneExisting,
      receiptOpen,
      receiptOpenNoCustomer,
      receiptRecent,
      receiptOld,
      receiptRejected,
      receiptRejectedOld,
      receiptCustomerId: receiptCustomer.id,
    };
  }

  const tenantReport = (report: BackfillReport, tenantId: string) =>
    report.tenants.find(
      (tenant) => tenant.tenantId === tenantId,
    ) as TenantBackfillReport;

  const totalCreated = (tenant: TenantBackfillReport) =>
    Object.values(tenant.create).reduce(
      (sum: number, counts: SubtypeCounts) =>
        sum + counts.open + counts.resolved,
      0,
    );

  const requestsOf = (tenantId: string) =>
    prisma.chatbotRequest.findMany({
      where: { tenantId },
      orderBy: { folio: 'asc' },
    });

  const wrappedIdOf = (request: {
    humanDecisionId: string | null;
    deliveryZoneRequestId: string | null;
    receiptEvidenceId: string | null;
  }) =>
    request.humanDecisionId ??
    request.deliveryZoneRequestId ??
    request.receiptEvidenceId;

  const requestOf = (tenantId: string, wrappedId: string) =>
    prisma.chatbotRequest.findFirst({
      where: {
        tenantId,
        OR: [
          { humanDecisionId: wrappedId },
          { deliveryZoneRequestId: wrappedId },
          { receiptEvidenceId: wrappedId },
        ],
      },
    });

  const group = (tenantId: string, customerKey: string) =>
    prisma.chatbotCustomerGroup.findUnique({
      where: { tenantId_customerKey: { tenantId, customerKey } },
    });

  async function expectClean(tenantId: string) {
    const [check] = (await checkInvariant(prisma, { tenantIds: [tenantId] }))
      .tenants;
    expect(check.mismatches).toEqual([]);
    return check;
  }

  /** Every wrapped row has exactly one request; folios unique per tenant. */
  async function expectWrappedOnce(tenantId: string) {
    const requests = await requestsOf(tenantId);
    const wrapped = requests.map(wrappedIdOf);
    expect(new Set(wrapped).size).toBe(wrapped.length);
    const folios = requests.map((request) => request.folio);
    expect(new Set(folios).size).toBe(folios.length);
    return requests;
  }

  // ------------------------------------------------------------- dry run

  describe('dry run', () => {
    it('counts per subtype, ambiguous customers and wrapped rows, and writes nothing', async () => {
      const fx = await seedLegacy();
      const before = await requestsOf(fx.tenantId);
      expect(before).toHaveLength(1); // only the pre-wrapped decision
      const counterBefore = await prisma.chatbotRequestFolioCounter.findUnique({
        where: { tenantId: fx.tenantId },
      });
      const groupsBefore = await prisma.chatbotCustomerGroup.count({
        where: { tenantId: fx.tenantId },
      });

      const report = await runBackfill(prisma, {
        apply: false,
        tenantIds: [fx.tenantId],
      });
      const tenant = tenantReport(report, fx.tenantId);

      expect(report.applied).toBe(false);
      expect(tenant.create).toEqual({
        RESTOCK: { open: 2, resolved: 1 },
        EXPIRATION: { open: 1, resolved: 1 },
        DELIVERY_ZONE: { open: 3, resolved: 1 },
        TRANSFER_RECEIPT: { open: 2, resolved: 1 },
      });
      expect(tenant.ambiguousCustomers).toBe(1);
      // Only the pre-wrapped decision is a qualifying row with a wrapper.
      expect(tenant.alreadyWrapped).toBe(1);
      expect(tenant.undatedRejectedReceipts).toBe(1);
      expect(tenant.changedUnderLock).toBe(0);

      expect(await requestsOf(fx.tenantId)).toEqual(before);
      expect(
        await prisma.chatbotRequestFolioCounter.findUnique({
          where: { tenantId: fx.tenantId },
        }),
      ).toEqual(counterBefore);
      expect(
        await prisma.chatbotCustomerGroup.count({
          where: { tenantId: fx.tenantId },
        }),
      ).toBe(groupsBefore);
    });
  });

  // ---------------------------------------------------------------- apply

  describe('apply', () => {
    it('wraps pending rows as NEW and the last 7 days of resolved rows as RESOLVED, nothing older', async () => {
      const fx = await seedLegacy();
      const report = await runBackfill(prisma, {
        apply: true,
        tenantIds: [fx.tenantId],
        batchSize: 3,
      });
      const tenant = tenantReport(report, fx.tenantId);
      expect(report.applied).toBe(true);
      expect(totalCreated(tenant)).toBe(12);
      expect(tenant.create.DELIVERY_ZONE).toEqual({ open: 3, resolved: 1 });
      expect(tenant.batches).toBeGreaterThan(1);

      const requests = await expectWrappedOnce(fx.tenantId);
      // 12 created + the pre-wrapped decision.
      expect(requests).toHaveLength(13);

      const wrappedIds = new Set(requests.map(wrappedIdOf));
      for (const skipped of [
        fx.restockOld,
        fx.zoneOld,
        fx.zoneExisting,
        fx.receiptOld,
        fx.receiptRejected,
        fx.receiptRejectedOld,
      ]) {
        expect(wrappedIds.has(skipped)).toBe(false);
      }

      // PENDING rows → NEW, with the wrapper source convention and no SLA.
      for (const id of [
        ...fx.restockOpen,
        fx.expirationOpen,
        ...Object.values(fx.zoneOpen),
        fx.receiptOpen,
        fx.receiptOpenNoCustomer,
      ]) {
        const request = await requestOf(fx.tenantId, id);
        expect(request).toMatchObject({
          kind: 'DECISION',
          status: 'NEW',
          version: 1,
          resolvedAt: null,
          closedAt: null,
          assigneeUserId: null,
          claimDeadlineAt: null,
          nextSlaCheckAt: null,
          sourceRequestId: id,
        });
      }
      expect(await requestOf(fx.tenantId, fx.restockOpen[0])).toMatchObject({
        subtype: 'RESTOCK',
        source: 'WRAP:HUMAN_DECISION',
        customerKey: `unknown:${fx.restockOpen[0]}`,
        summary: 'Stock: Croquetas 20 kg',
      });
      expect(await requestOf(fx.tenantId, fx.expirationOpen)).toMatchObject({
        subtype: 'EXPIRATION',
        summary: 'Caducidad: Croquetas 20 kg',
      });

      // The creation date of the wrapped row is kept for the inbox order.
      const oldest = await prisma.humanDecision.findUniqueOrThrow({
        where: { id: fx.restockOpen[1] },
      });
      expect(
        (await requestOf(fx.tenantId, fx.restockOpen[1]))?.createdAt,
      ).toEqual(oldest.createdAt);

      // RESOLVED rows copy resolvedAt and who resolved them.
      const recent = await prisma.humanDecision.findUniqueOrThrow({
        where: { id: fx.restockRecent },
      });
      expect(await requestOf(fx.tenantId, fx.restockRecent)).toMatchObject({
        status: 'RESOLVED',
        resolvedAt: recent.resolvedAt,
        closedAt: recent.resolvedAt,
        resolvedByActorId: reviewer,
        resolvedByDisplayName: 'Revisora',
        resolution: containing({
          action: 'PROVIDE_RESTOCK_ESTIMATE',
          via: 'BACKFILL',
        }),
      });
      const zoneRecentRow = await prisma.deliveryZoneRequest.findUniqueOrThrow({
        where: { id: fx.zoneRecent },
      });
      expect(await requestOf(fx.tenantId, fx.zoneRecent)).toMatchObject({
        subtype: 'DELIVERY_ZONE',
        status: 'RESOLVED',
        resolvedAt: zoneRecentRow.resolvedAt,
        resolvedByActorId: reviewer,
        resolution: containing({
          action: 'APPROVE_DELIVERY_ZONE',
          via: 'BACKFILL',
        }),
      });
      const receiptRecentRow = await prisma.receiptEvidence.findUniqueOrThrow({
        where: { id: fx.receiptRecent },
      });
      expect(await requestOf(fx.tenantId, fx.receiptRecent)).toMatchObject({
        subtype: 'TRANSFER_RECEIPT',
        status: 'RESOLVED',
        resolvedAt: receiptRecentRow.confirmedAt,
        resolvedByActorId: reviewer,
        resolvedByDisplayName: 'Revisora',
        resolution: containing({
          action: 'CONFIRM_RECEIPT',
          via: 'BACKFILL',
        }),
      });

      // One BACKFILLED-marked event per request, written by the system.
      const events = await prisma.chatbotRequestEvent.findMany({
        where: { tenantId: fx.tenantId },
      });
      expect(events).toHaveLength(requests.length);
      const backfilled = events.filter(
        (event) =>
          (event.data as { backfilled?: boolean } | null)?.backfilled === true,
      );
      expect(backfilled).toHaveLength(12);
      for (const event of backfilled) {
        expect(event).toMatchObject({
          actorKind: 'SYSTEM',
          actorId: null,
          version: 1,
        });
        const request = requests.find((r) => r.id === event.requestId);
        expect(event.toStatus).toBe(request?.status);
      }
    });

    it('applies R1 to zone requesters: one customer links, two are ambiguous, none stays unlinked', async () => {
      const fx = await seedLegacy();
      await runBackfill(prisma, { apply: true, tenantIds: [fx.tenantId] });

      expect(await requestOf(fx.tenantId, fx.zoneOpen.plain)).toMatchObject({
        customerKey: '525511111111',
        customerId: null,
        ambiguousCustomer: false,
        phoneCountryCode: '52',
        phone: '5511111111',
      });
      expect(await requestOf(fx.tenantId, fx.zoneOpen.linked)).toMatchObject({
        customerKey: '525522222222',
        customerId: fx.linkedCustomerId,
        ambiguousCustomer: false,
      });
      expect(await requestOf(fx.tenantId, fx.zoneOpen.ambiguous)).toMatchObject(
        {
          customerKey: '525533333333',
          customerId: null,
          ambiguousCustomer: true,
        },
      );
      // Zone requests keep the conversation and the 24 h window of the hook.
      const row = await prisma.deliveryZoneRequest.findUniqueOrThrow({
        where: { id: fx.zoneOpen.plain },
      });
      const request = await requestOf(fx.tenantId, fx.zoneOpen.plain);
      expect(request).toMatchObject({
        conversationRef: row.conversationRef,
        lastCustomerMessageAt: row.lastCustomerMessageAt,
      });
      expect(request?.whatsappWindowClosesAt?.getTime()).toBe(
        row.lastCustomerMessageAt.getTime() + DAY_MS,
      );

      // A receipt uses Sale.customerId as is; without a customer the key is
      // the same unknown:<id> a 3a hook would write.
      expect(await requestOf(fx.tenantId, fx.receiptOpen)).toMatchObject({
        customerId: fx.receiptCustomerId,
        customerKey: '525577777777',
        ambiguousCustomer: false,
      });
      expect(
        await requestOf(fx.tenantId, fx.receiptOpenNoCustomer),
      ).toMatchObject({
        customerId: null,
        customerKey: `unknown:${fx.receiptOpenNoCustomer}`,
      });
    });

    it('allocates unique, contiguous folios from the tenant counter', async () => {
      const fx = await seedLegacy();
      await runBackfill(prisma, {
        apply: true,
        tenantIds: [fx.tenantId],
        batchSize: 4,
      });
      const requests = await expectWrappedOnce(fx.tenantId);
      expect(requests.map((request) => request.folio)).toEqual(
        Array.from({ length: requests.length }, (_, i) => i + 1),
      );
      expect(
        (
          await prisma.chatbotRequestFolioCounter.findUniqueOrThrow({
            where: { tenantId: fx.tenantId },
          })
        ).lastNumber,
      ).toBe(requests.length);
    });

    it('refreshes the customer groups: one per open customer, none for resolved-only', async () => {
      const fx = await seedLegacy();
      await runBackfill(prisma, { apply: true, tenantIds: [fx.tenantId] });

      const open = (await requestsOf(fx.tenantId)).filter(
        (request) => request.status === 'NEW',
      );
      const expected = new Map<string, number>();
      for (const request of open) {
        expected.set(
          request.customerKey,
          (expected.get(request.customerKey) ?? 0) + 1,
        );
      }
      const groups = await prisma.chatbotCustomerGroup.findMany({
        where: { tenantId: fx.tenantId },
      });
      expect(groups).toHaveLength(expected.size);
      for (const [customerKey, openCount] of expected) {
        expect(await group(fx.tenantId, customerKey)).toMatchObject({
          openCount,
          hasOverdue: false,
        });
      }
      // The resolved-only customer has no group; two zone requesters share a
      // validation but are different customers, so each has its own group.
      expect(await group(fx.tenantId, '525544444444')).toBeNull();
      expect(await group(fx.tenantId, '525511111111')).toMatchObject({
        openCount: 1,
      });
      expect(await group(fx.tenantId, '525522222222')).toMatchObject({
        openCount: 1,
      });
    });

    it('keeps the §2.1 invariant: every open wrapped row has one open request and the states agree', async () => {
      const fx = await seedLegacy();
      const before = await checkInvariant(prisma, {
        tenantIds: [fx.tenantId],
      });
      // 8 open legacy rows without a request (the pre-wrapped one is fine).
      expect(
        before.tenants[0].mismatches.filter(
          (m) => m.kind === 'MISSING_REQUEST',
        ),
      ).toHaveLength(8);
      expect(before.tenants[0].mismatches.length).toBe(8);

      await runBackfill(prisma, { apply: true, tenantIds: [fx.tenantId] });
      const check = await expectClean(fx.tenantId);
      expect(check.openWrapped).toBe(9);
      expect(check.openRequests).toBe(9);
    });

    it('is idempotent: the second run has nothing to create and changes nothing', async () => {
      const fx = await seedLegacy();
      await runBackfill(prisma, { apply: true, tenantIds: [fx.tenantId] });
      const after = await requestsOf(fx.tenantId);
      const eventsAfter = await prisma.chatbotRequestEvent.count({
        where: { tenantId: fx.tenantId },
      });

      for (const apply of [false, true]) {
        const report = await runBackfill(prisma, {
          apply,
          tenantIds: [fx.tenantId],
        });
        const tenant = tenantReport(report, fx.tenantId);
        expect(totalCreated(tenant)).toBe(0);
        expect(tenant.ambiguousCustomers).toBe(0);
        // 13 wrapped rows qualify now (the 12 created + the pre-wrapped one).
        expect(tenant.alreadyWrapped).toBe(13);
      }
      expect(await requestsOf(fx.tenantId)).toEqual(after);
      expect(
        await prisma.chatbotRequestEvent.count({
          where: { tenantId: fx.tenantId },
        }),
      ).toBe(eventsAfter);
      await expectClean(fx.tenantId);
    });

    it('only touches the tenants it is given', async () => {
      const a = await seedLegacy();
      const b = await seedLegacy();
      await runBackfill(prisma, { apply: true, tenantIds: [a.tenantId] });
      expect(await requestsOf(a.tenantId)).toHaveLength(13);
      expect(await requestsOf(b.tenantId)).toHaveLength(1);
      expect(await group(b.tenantId, '525511111111')).toBeNull();

      const all = await runBackfill(prisma, {
        apply: true,
        tenantIds: [a.tenantId, b.tenantId],
      });
      expect(totalCreated(tenantReport(all, a.tenantId))).toBe(0);
      expect(totalCreated(tenantReport(all, b.tenantId))).toBe(12);
      // Folios are per tenant: each starts over.
      expect((await requestsOf(b.tenantId))[0].folio).toBe(1);
    });
  });

  // --------------------------------------------------------------- check

  describe('--check (invariant)', () => {
    it('reports an open wrapped row without a request, a state disagreement and a wrong group', async () => {
      const fx = await seedLegacy();
      await runBackfill(prisma, { apply: true, tenantIds: [fx.tenantId] });
      await expectClean(fx.tenantId);

      // Behind the application's back: a wrapped row resolved without closing
      // its request, a new open wrapped row with no request, a tampered group.
      await prisma.humanDecision.update({
        where: { id: fx.restockOpen[0] },
        data: {
          status: 'RESOLVED',
          version: 2,
          resolutionAction: 'PROVIDE_RESTOCK_ESTIMATE',
          restockDays: 3,
          resolutionRequestId: randomUUID(),
          resolvedAt: new Date(),
          resolvedByActorId: reviewer,
          resolvedByDisplayName: 'Revisora',
        },
      });
      const orphan = await seedDecision(fx.tenantId, {
        type: 'EXPIRATION',
        createdDaysAgo: 1,
      });
      await prisma.chatbotCustomerGroup.update({
        where: {
          tenantId_customerKey: {
            tenantId: fx.tenantId,
            customerKey: '525511111111',
          },
        },
        data: { openCount: 5 },
      });

      const [check] = (
        await checkInvariant(prisma, { tenantIds: [fx.tenantId] })
      ).tenants;
      const byKind = (kind: string) =>
        check.mismatches.filter((m) => m.kind === kind);
      expect(byKind('STATE_DISAGREES')).toEqual([
        expect.objectContaining({ subtype: 'RESTOCK', id: fx.restockOpen[0] }),
      ]);
      expect(byKind('MISSING_REQUEST')).toEqual([
        expect.objectContaining({ subtype: 'EXPIRATION', id: orphan }),
      ]);
      expect(byKind('GROUP_MISMATCH')).toHaveLength(1);
      // The group key is a phone: only a masked form may be reported.
      expect(JSON.stringify(byKind('GROUP_MISMATCH'))).not.toContain(
        '525511111111',
      );
      expect(check.mismatches).toHaveLength(3);

      // The backfill repairs the missing wrapper and leaves the rest alone.
      await runBackfill(prisma, { apply: true, tenantIds: [fx.tenantId] });
      const [again] = (
        await checkInvariant(prisma, { tenantIds: [fx.tenantId] })
      ).tenants;
      expect(again.mismatches.map((m) => m.kind).sort()).toEqual([
        'GROUP_MISMATCH',
        'STATE_DISAGREES',
      ]);
    });

    it('ignores cancelled requests (a customer cancel leaves the wrapped row pending)', async () => {
      const fx = await seedLegacy();
      await runBackfill(prisma, { apply: true, tenantIds: [fx.tenantId] });
      const request = await requestOf(fx.tenantId, fx.expirationOpen);
      await prisma.$executeRaw`
        UPDATE "chatbot_requests"
        SET "status" = 'CANCELLED', "cancelledAt" = now(),
            "cancelReason" = 'CUSTOMER_WITHDREW', "closedAt" = now()
        WHERE "id" = ${request?.id}`;
      await prisma.$executeRaw`
        DELETE FROM "chatbot_customer_groups"
        WHERE "tenantId" = ${fx.tenantId}
          AND "customerKey" = ${`unknown:${fx.expirationOpen}`}`;
      await expectClean(fx.tenantId);
    });
  });

  // ---------------------------------------------------------------- races

  describe('races', () => {
    it('a request that appears between planning and the lock is skipped, not duplicated (ON CONFLICT DO NOTHING)', async () => {
      const fx = await seedLegacy();
      const planted = fx.restockOpen[0];
      let plantedOnce = false;
      const report = await runBackfill(prisma, {
        apply: true,
        tenantIds: [fx.tenantId],
        batchSize: 100,
        onBatchPlanned: async (batch) => {
          if (plantedOnce || !batch.ids.includes(planted)) return;
          plantedOnce = true;
          // Another writer wraps the row after the backfill chose it.
          await inTenant(fx.tenantId, () =>
            tenantPrisma.runInTransaction(() =>
              wrapper.wrapHumanDecision({
                id: planted,
                type: 'RESTOCK',
                productId: randomUUID(),
                productName: 'Croquetas 20 kg',
                variantId: null,
              }),
            ),
          );
        },
      });
      const tenant = tenantReport(report, fx.tenantId);
      expect(plantedOnce).toBe(true);
      expect(tenant.changedUnderLock).toBe(1);
      expect(totalCreated(tenant)).toBe(11);
      const requests = await expectWrappedOnce(fx.tenantId);
      expect(requests).toHaveLength(13);
      // The planted wrapper is the 3a one (CREATED event, no backfill mark).
      const winner = await requestOf(fx.tenantId, planted);
      const events = await prisma.chatbotRequestEvent.findMany({
        where: { requestId: winner?.id },
      });
      expect(events).toHaveLength(1);
      expect(events[0].data).toMatchObject({ wrapped: true });
      expect(events[0].data).not.toMatchObject({ backfilled: true });
      await expectClean(fx.tenantId);
    });

    it('two backfills at once wrap every row exactly once, without deadlock', async () => {
      const fx = await seedLegacy();
      const runs = await guarded(
        Promise.all([
          runBackfill(prisma, {
            apply: true,
            tenantIds: [fx.tenantId],
            batchSize: 2,
          }),
          runBackfill(prisma, {
            apply: true,
            tenantIds: [fx.tenantId],
            batchSize: 3,
          }),
        ]),
      );
      const created = runs.reduce(
        (sum, run) => sum + totalCreated(tenantReport(run, fx.tenantId)),
        0,
      );
      expect(created).toBe(12);
      const requests = await expectWrappedOnce(fx.tenantId);
      expect(requests).toHaveLength(13);
      expect(
        (
          await prisma.chatbotRequestFolioCounter.findUniqueOrThrow({
            where: { tenantId: fx.tenantId },
          })
        ).lastNumber,
      ).toBe(13);
      await expectClean(fx.tenantId);
    });

    it('runs beside the 3a creation hooks: no duplicate wrapper, unique folios, consistent groups, no deadlock', async () => {
      const fx = await seedLegacy();
      const sale = await seedSale(fx.tenantId, fx.receiptCustomerId);

      const restocks = Array.from({ length: 12 }, () =>
        inTenant(fx.tenantId, () =>
          restockIntake.submit({
            sourceRequestId: randomUUID(),
            productId: randomUUID(),
            productName: 'Croquetas 20 kg',
            submittedCredentialId: 'cred',
          }),
        ),
      );
      // Same postal code and the same customers as the legacy requesters, so
      // hooks and backfill contend for the zip lock and for the same groups.
      const zones = [
        '5511111111',
        '5522222222',
        '5533333333',
        '5599999999',
      ].map((phone) => {
        const sourceRequestId = randomUUID();
        return inTenant(fx.tenantId, () =>
          zoneBot.submit({
            submittedCredentialId: 'cred',
            request: {
              sourceRequestId,
              originalSourceRequestId: sourceRequestId,
              type: DELIVERY_ZONE_TYPE,
              zipCode: '64000',
              state: 'Nuevo León',
              municipality: 'Monterrey',
              neighborhood: 'Centro',
              phoneCountryCode: '52',
              phone,
              conversationRef: `conv-${sourceRequestId}`,
              lastCustomerMessageAt: new Date(),
            },
          }),
        );
      });
      const receipts = Array.from({ length: 4 }, () =>
        inTenant(fx.tenantId, () =>
          receiptUpload.attachLegacyUrl({
            saleId: sale.id,
            mediaUrl: 'https://example.test/comprobante.jpg',
            declaredAmountCents: 10_000,
            declaredDate: null,
            declaredReference: null,
          }),
        ),
      );

      const [report] = await guarded(
        Promise.all([
          runBackfill(prisma, {
            apply: true,
            tenantIds: [fx.tenantId],
            batchSize: 2,
          }),
          ...restocks,
          ...zones,
          ...receipts,
        ]),
      );

      expect(totalCreated(tenantReport(report, fx.tenantId))).toBe(12);
      const requests = await expectWrappedOnce(fx.tenantId);
      // 13 from the legacy fixture + 12 + 4 + 4 from the live hooks.
      expect(requests).toHaveLength(33);
      expect(
        requests.map((request) => request.folio).sort((a, b) => a - b),
      ).toEqual(Array.from({ length: 33 }, (_, i) => i + 1));
      await expectClean(fx.tenantId);
      // The zone customers got one group each, hooks and backfill together.
      expect(await group(fx.tenantId, '525511111111')).toMatchObject({
        openCount: 2,
      });
      expect(await group(fx.tenantId, '525599999999')).toMatchObject({
        openCount: 1,
      });
    });

    it('a legacy resolve racing the backfill ends consistent either way (decision and zone)', async () => {
      const fx = await seedLegacy();
      await guarded(
        Promise.all([
          runBackfill(prisma, {
            apply: true,
            tenantIds: [fx.tenantId],
            batchSize: 2,
          }),
          inTenant(fx.tenantId, () =>
            decisions.resolve({
              decisionId: fx.restockOpen[0],
              expectedVersion: 1,
              resolutionRequestId: randomUUID(),
              action: 'PROVIDE_RESTOCK_ESTIMATE',
              restockDays: 3,
              actorUserId: reviewer,
              actorIsSuperAdmin: false,
            }),
          ),
          inTenant(fx.tenantId, () =>
            validations.resolve({
              validationId: fx.validationOpen,
              expectedVersion: 1,
              resolutionRequestId: randomUUID(),
              action: APPROVE_DELIVERY_ZONE,
              settings: { type: 'FREE', surchargeCents: null, etaDays: 2 },
              actorUserId: reviewer,
              actorIsSuperAdmin: false,
            }),
          ),
        ]),
      );
      await expectWrappedOnce(fx.tenantId);
      await expectClean(fx.tenantId);
      // Both resolved rows are wrapped, and their requests are closed.
      for (const id of [fx.restockOpen[0], ...Object.values(fx.zoneOpen)]) {
        expect(await requestOf(fx.tenantId, id)).toMatchObject({
          status: 'RESOLVED',
        });
      }
      expect(await group(fx.tenantId, '525511111111')).toBeNull();
    });
  });

  // -------------------------------------------------------------- volume

  it('wraps a few hundred rows in small transactions (timing for the runbook)', async () => {
    const tenantId = await newTenant();
    const decisionsData = Array.from({ length: 300 }, (_, i) => ({
      tenantId,
      source: 'houndfe-chatbot',
      sourceRequestId: randomUUID(),
      type: 'RESTOCK' as const,
      canonicalRequestHash: 'hash',
      submittedCredentialId: 'cred',
      branchId: 'branch',
      productId: randomUUID(),
      productName: `Producto ${i}`,
      createdAt: ago(1, new Date(Date.now() - i * 1000)),
    }));
    await prisma.humanDecision.createMany({ data: decisionsData });

    const started = Date.now();
    const report = await runBackfill(prisma, {
      apply: true,
      tenantIds: [tenantId],
    });
    const elapsed = Date.now() - started;
    const tenant = tenantReport(report, tenantId);
    expect(tenant.create.RESTOCK.open).toBe(300);
    expect(tenant.batches).toBe(3);
    console.log(`[backfill] 300 decisions in ${elapsed} ms (3 batches of 100)`);
    await expectWrappedOnce(tenantId);
    await expectClean(tenantId);
    const rerun = await runBackfill(prisma, {
      apply: false,
      tenantIds: [tenantId],
    });
    expect(totalCreated(tenantReport(rerun, tenantId))).toBe(0);
  });
});
