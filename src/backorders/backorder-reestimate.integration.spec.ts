/**
 * restock-backorder / T4 — the overdue-ETA re-estimate against REAL PostgreSQL
 * (contract v1 §8; owner D6; chatbot adjustment «UN re-estimado por (tenant,
 * productId, variantId)»).
 *
 * Boots the REAL `BackordersModule` graph (which now imports
 * `HumanDecisionsModule`: the RESTOCK intake, the resolve adapter and the
 * resolution registry) with only the bot credential repository replaced. The
 * sweep is driven through `tick(now)`; staff resolve through the SAME
 * `PrismaHumanDecisionReviewResolveRepository` the `POST
 * /human-decisions/:id/resolve` route calls. Cleanup deletes only what it
 * created (tenants cascade).
 *
 * Proves:
 *   - five overdue WAITING backorders of one product → ONE server-side RESTOCK
 *     decision (staff-only wrapper, no conversation, no customer, no feed item
 *     for the bot, the customer told nothing), and the decision is also ONE
 *     under concurrent ticks / replicas;
 *   - a newly overdue backorder attaches to the pending decision; other
 *     products and variants get their own; not-overdue / RESERVED / CANCELLED /
 *     answered rows are never asked;
 *   - the staff resolution answers every attached WAITING backorder in the SAME
 *     transaction: PROVIDE → `eta_updated` {estimatedAt = resolvedAt + days,
 *     restockDays} with the version bumped, UNAVAILABLE → `eta_unavailable`,
 *     exactly once each, no generic `request.answered`; a RESERVED / CANCELLED
 *     backorder is skipped;
 *   - once only: etaStage 2 is never asked again; round 2 opens only after
 *     round 1 was answered;
 *   - an ordinary (bot-created) RESTOCK keeps its `request.answered` and
 *     touches no backorder; a failing listener never blocks the resolution
 *     and the sweep repair answers later; concurrency between the attach and
 *     the resolution loses no answer.
 */
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { ClsModule, ClsService } from 'nestjs-cls';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../chatbot-api/domain/service-credential.repository';
import {
  BotCredentials,
  disconnectWorldPrisma,
  worldPrisma,
} from '../delivery-zones/test-support/delivery-zone-world';
import {
  HUMAN_DECISION_REVIEW_RESOLVE_REPOSITORY,
  type IHumanDecisionReviewResolveRepository,
} from '../human-decisions/domain/human-decision-review-resolve.repository';
import {
  RESTOCK_INTAKE_REPOSITORY,
  type IRestockIntakeRepository,
} from '../human-decisions/domain/restock-intake.repository';
import { DomainExceptionFilter } from '../shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from '../shared/filters/prisma-exception.filter';
import { createAppValidationPipe } from '../shared/listing/app-validation.pipe';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import { BackordersModule } from './backorders.module';
import { BACKORDER_SCOPES } from './domain/backorder-scopes';
import {
  REESTIMATE_SYSTEM_CREDENTIAL_ID,
  reestimateSourceRequestId,
} from './domain/backorder-reestimate';
import { BackorderReestimateService } from './infrastructure/backorder-reestimate.service';
import { BackorderSweepScheduler } from './infrastructure/backorder-sweep.scheduler';

const SKIP =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const d = SKIP ? describe.skip : describe;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const RESOLVED_AT = new Date(Date.now() - 10 * DAY);
const ALL_SCOPES = [
  BACKORDER_SCOPES.create,
  BACKORDER_SCOPES.read,
  BACKORDER_SCOPES.cancel,
];

d('backorder overdue-ETA re-estimate (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const credentials = new BotCredentials();
  const tenantIds: string[] = [];
  const userIds: string[] = [];
  const createdPriceListIds: string[] = [];
  let app: INestApplication;
  let publicListId: string;
  let cls: ClsService<TenantClsStore>;
  let sweep: BackorderSweepScheduler;
  let resolver: IHumanDecisionReviewResolveRepository;
  let intake: IRestockIntakeRepository;
  let reestimate: BackorderReestimateService;

  beforeAll(async () => {
    const existingDefault = await prisma.globalPriceList.findFirst({
      where: { isDefault: true },
    });
    if (existingDefault) {
      publicListId = existingDefault.id;
    } else {
      const created = await prisma.globalPriceList.create({
        data: { name: `PUBLICO-eta-${randomUUID()}`, isDefault: true },
      });
      createdPriceListIds.push(created.id);
      publicListId = created.id;
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              PROMOTIONS_BUSINESS_TIMEZONE: 'America/Mexico_City',
              JWT_SECRET: 'backorder-eta-test-secret',
              JWT_REFRESH_SECRET: 'backorder-eta-test-refresh',
              SPACES_BUCKET: 'unused',
              SPACES_ENDPOINT: 'https://unused.invalid',
              SPACES_REGION: 'unused',
              SPACES_ACCESS_KEY_ID: 'unused',
              SPACES_SECRET_ACCESS_KEY: 'unused',
              SPACES_PUBLIC_BASE_URL: 'https://unused.invalid',
              SPACES_UPLOAD_MAX_MB: '5',
            }),
          ],
        }),
        EventEmitterModule.forRoot(),
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
        BackordersModule,
      ],
    })
      .overrideProvider(SERVICE_CREDENTIAL_REPOSITORY)
      .useValue(credentials.repository)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createAppValidationPipe());
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new PrismaExceptionFilter(),
    );
    await app.init();
    const get = <T>(token: unknown): T =>
      moduleRef.get(token as never, { strict: false });
    cls = moduleRef.get(ClsService, { strict: false });
    sweep = get(BackorderSweepScheduler);
    resolver = get(HUMAN_DECISION_REVIEW_RESOLVE_REPOSITORY);
    intake = get(RESTOCK_INTAKE_REPOSITORY);
    reestimate = get(BackorderReestimateService);
  });

  /**
   * The sweep is cross-tenant: each test removes its own tenants (cascade) so a
   * later tick never sees the leftovers of an earlier one.
   */
  async function dropTenants(): Promise<void> {
    if (tenantIds.length === 0) return;
    const ids = tenantIds.splice(0);
    await prisma.outboxEvent.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.backorder.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
  }

  afterEach(async () => {
    jest.restoreAllMocks();
    await dropTenants();
  });

  afterAll(async () => {
    await app?.close();
    await dropTenants();
    if (userIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    if (createdPriceListIds.length > 0) {
      await prisma.globalPriceList.deleteMany({
        where: { id: { in: createdPriceListIds } },
      });
    }
    await disconnectWorldPrisma();
  });

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  interface World {
    tenantId: string;
    token: string;
    productId: string;
    decisionId: string;
    customers: string[];
    actorId: string;
  }

  const phoneOf = (n: number) => ({
    phoneCountryCode: '52',
    phone: `55123488${String(n).padStart(2, '0')}`,
  });

  async function world(): Promise<World> {
    const tenantId = randomUUID();
    tenantIds.push(tenantId);
    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: `Sucursal ${tenantId.slice(0, 6)}`,
        slug: `eta-${tenantId}`,
      },
    });
    const productId = randomUUID();
    await prisma.product.create({
      data: {
        id: productId,
        tenantId,
        name: 'Croquetas Adulto 18 kg',
        sku: 'CRQ-18',
        useStock: true,
        quantity: 0,
      },
    });
    await prisma.priceList.create({
      data: {
        tenantId,
        productId,
        globalPriceListId: publicListId,
        priceCents: 1000,
      },
    });
    const customers: string[] = [];
    for (let n = 1; n <= 8; n++) {
      const id = randomUUID();
      await prisma.customer.create({
        data: { id, tenantId, firstName: `Cliente${n}`, ...phoneOf(n) },
      });
      customers.push(id);
    }
    const decision = await prisma.humanDecision.create({
      data: {
        tenantId,
        source: 'houndfe-chatbot',
        sourceRequestId: randomUUID(),
        type: 'RESTOCK',
        canonicalRequestHash: 'h'.repeat(64),
        submittedCredentialId: 'cred',
        branchId: tenantId,
        branchName: 'Centro',
        productId,
        productName: 'Croquetas',
        status: 'RESOLVED',
        version: 2,
        resolutionAction: 'PROVIDE_RESTOCK_ESTIMATE',
        restockDays: 7,
        resolutionRequestId: randomUUID(),
        resolvedAt: RESOLVED_AT,
        resolvedByActorId: 'actor',
        resolvedByDisplayName: 'Gerente',
      },
    });
    const actorId = randomUUID();
    userIds.push(actorId);
    await prisma.user.create({
      data: {
        id: actorId,
        email: `eta-${actorId}@test.local`,
        hashedPassword: 'x',
        name: 'Gerente Reposición',
      },
    });
    return {
      tenantId,
      token: credentials.register(tenantId, ALL_SCOPES),
      productId,
      decisionId: decision.id,
      customers,
      actorId,
    };
  }

  /**
   * WAITING backorders in queue order whose estimate passed `overdueByMs` ago
   * (negative = still in the future).
   */
  async function waiting(
    w: World,
    count: number,
    options: {
      productId?: string;
      variantId?: string | null;
      customerOffset?: number;
      overdueByMs?: number;
      etaStage?: number;
    } = {},
  ) {
    const base = Date.now() - 10 * HOUR;
    const overdueBy = options.overdueByMs ?? DAY;
    const rows: Array<Awaited<ReturnType<typeof prisma.backorder.create>>> = [];
    for (let i = 0; i < count; i++) {
      rows.push(
        await prisma.backorder.create({
          data: {
            tenantId: w.tenantId,
            folio: `BO-${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
            customerId: w.customers[(options.customerOffset ?? 0) + i],
            productId: options.productId ?? w.productId,
            variantId: options.variantId ?? null,
            quantity: 1,
            referencePriceCents: 1000,
            scheduledAt: new Date(base + i * 1000),
            estimatedArrivalDays: 7,
            estimatedAt: new Date(Date.now() - overdueBy),
            etaStage: options.etaStage ?? 0,
            sourceDecisionId: w.decisionId,
            idempotencyKey: randomUUID(),
            requestHash: 'a'.repeat(64),
          },
        }),
      );
    }
    return rows;
  }

  const inTenant = <T>(w: World, work: () => T): T =>
    cls.runWith(
      { tenantId: w.tenantId, userId: 'test', isSuperAdmin: false },
      work,
    );

  const backorder = (id: string) =>
    prisma.backorder.findUniqueOrThrow({ where: { id } });
  const reDecisions = (w: World, productId = w.productId) =>
    prisma.humanDecision.findMany({
      where: {
        tenantId: w.tenantId,
        productId,
        submittedCredentialId: REESTIMATE_SYSTEM_CREDENTIAL_ID,
      },
      orderBy: { createdAt: 'asc' },
    });
  const etaItems = (w: World, type?: string, backorderId?: string) =>
    prisma.chatbotFeedItem.findMany({
      where: {
        tenantId: w.tenantId,
        backorderId: backorderId ?? { not: null },
        type: type ?? {
          in: ['backorder.eta_updated', 'backorder.eta_unavailable'],
        },
      },
      orderBy: { cursor: 'asc' },
    });
  const allFeed = (w: World) =>
    prisma.chatbotFeedItem.findMany({ where: { tenantId: w.tenantId } });
  const wrapperOf = (decisionId: string) =>
    prisma.chatbotRequest.findFirst({ where: { humanDecisionId: decisionId } });

  /** Staff resolve through the adapter `POST /human-decisions/:id/resolve` uses. */
  const resolve = (
    w: World,
    decisionId: string,
    answer:
      | { action: 'PROVIDE_RESTOCK_ESTIMATE'; restockDays: number }
      | { action: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE' },
    resolutionRequestId = randomUUID(),
  ) =>
    inTenant(w, () =>
      resolver.resolve({
        decisionId,
        expectedVersion: 1,
        resolutionRequestId,
        actorUserId: w.actorId,
        actorIsSuperAdmin: true,
        ...answer,
      } as never),
    );

  const tick = (now = new Date()) => sweep.tick(now);
  const deadlocks = (results: PromiseSettledResult<unknown>[]) =>
    results.filter(
      (r) =>
        r.status === 'rejected' &&
        /deadlock|40P01/i.test(
          String((r.reason as Error)?.message ?? r.reason),
        ),
    );

  // ---------------------------------------------------------------------------
  // Sweep: one decision per product, the customer told nothing
  // ---------------------------------------------------------------------------

  describe('the sweep asks staff once per product', () => {
    it('five overdue WAITING backorders of one product → ONE server-side RESTOCK decision, attached, customers told nothing', async () => {
      const w = await world();
      const rows = await waiting(w, 5);

      const total = await tick();
      expect(total.reestimates).toBeGreaterThanOrEqual(1);
      expect(total.failed).toBe(0);

      const decisions = await reDecisions(w);
      expect(decisions).toHaveLength(1);
      const [decision] = decisions;
      expect(decision).toMatchObject({
        tenantId: w.tenantId,
        source: 'houndfe-chatbot',
        type: 'RESTOCK',
        status: 'PENDING',
        version: 1,
        productId: w.productId,
        variantId: null,
        productName: 'Croquetas Adulto 18 kg',
        sku: 'CRQ-18',
        requestedQuantity: null,
        observedStockAtRequest: null,
        submittedCredentialId: REESTIMATE_SYSTEM_CREDENTIAL_ID,
        sourceRequestId: reestimateSourceRequestId(
          w.tenantId,
          w.productId,
          null,
          1,
        ),
      });

      for (const row of rows) {
        expect(await backorder(row.id)).toMatchObject({
          status: 'WAITING',
          etaStage: 1,
          reestimateDecisionId: decision.id,
          // The attach is silent: no version bump, nothing changes for the customer.
          version: row.version,
          estimatedAt: row.estimatedAt,
        });
      }
      // Staff-only wrapper: a RESTOCK request with no customer and no chat,
      // recognisable by its origin and summary.
      const request = await wrapperOf(decision.id);
      expect(request).toMatchObject({
        subtype: 'RESTOCK',
        status: 'NEW',
        conversationRef: null,
        customerId: null,
        summary: 'Reposición vencida: Croquetas Adulto 18 kg',
        context: {
          origin: 'BACKORDER_REESTIMATE',
          productId: w.productId,
          variantId: null,
        },
      });
      // The bot hears NOTHING at this point.
      expect(await allFeed(w)).toEqual([]);
    });

    it('a second tick, and ticks without new overdue backorders, change nothing', async () => {
      const w = await world();
      await waiting(w, 3);
      await tick();
      const [decision] = await reDecisions(w);
      const before = await prisma.backorder.findMany({
        where: { tenantId: w.tenantId },
        orderBy: { id: 'asc' },
      });

      await tick();
      await tick(new Date(Date.now() + HOUR));

      expect(await reDecisions(w)).toHaveLength(1);
      expect(
        await prisma.backorder.findMany({
          where: { tenantId: w.tenantId },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(before);
      expect(decision.status).toBe('PENDING');
      expect(
        await prisma.chatbotRequest.count({
          where: { tenantId: w.tenantId },
        }),
      ).toBe(1);
    });

    it('a newly overdue backorder of the same product attaches to the PENDING decision instead of creating another', async () => {
      const w = await world();
      await waiting(w, 2);
      await tick();
      const [decision] = await reDecisions(w);

      const [late] = await waiting(w, 1, { customerOffset: 2 });
      await tick();

      expect(await reDecisions(w)).toHaveLength(1);
      expect(await backorder(late.id)).toMatchObject({
        etaStage: 1,
        reestimateDecisionId: decision.id,
      });
      expect(
        await prisma.chatbotRequest.count({
          where: { tenantId: w.tenantId },
        }),
      ).toBe(1);
    });

    it('only WAITING, etaStage 0, estimatedAt in the past are asked: future, RESERVED, CANCELLED and already answered rows are left alone', async () => {
      const w = await world();
      const [overdue] = await waiting(w, 1);
      const [future] = await waiting(w, 1, {
        customerOffset: 1,
        overdueByMs: -DAY,
      });
      const [reserved] = await waiting(w, 1, { customerOffset: 2 });
      const [cancelled] = await waiting(w, 1, { customerOffset: 3 });
      const [answered] = await waiting(w, 1, {
        customerOffset: 4,
        etaStage: 2,
      });
      await prisma.backorder.update({
        where: { id: reserved.id },
        data: {
          status: 'RESERVED',
          reservedAt: new Date(),
          reservedUntil: new Date(Date.now() + DAY),
          reminderAt: new Date(Date.now() + DAY - 3 * HOUR),
          currentPriceCents: 900,
          finalPriceCents: 900,
        },
      });
      await prisma.backorder.update({
        where: { id: cancelled.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledByKind: 'CUSTOMER',
        },
      });

      await tick();

      const [decision] = await reDecisions(w);
      expect(await backorder(overdue.id)).toMatchObject({
        etaStage: 1,
        reestimateDecisionId: decision.id,
      });
      for (const row of [future, reserved, cancelled]) {
        expect(await backorder(row.id)).toMatchObject({
          etaStage: 0,
          reestimateDecisionId: null,
        });
      }
      // Once only: an overdue backorder already answered is never asked again.
      expect(await backorder(answered.id)).toMatchObject({
        etaStage: 2,
        reestimateDecisionId: null,
      });
    });

    it('a product with only answered / not-overdue rows creates no decision at all', async () => {
      const w = await world();
      await waiting(w, 2, { etaStage: 2 });
      await waiting(w, 2, { customerOffset: 2, overdueByMs: -DAY });
      await tick();
      expect(await reDecisions(w)).toEqual([]);
      expect(
        await prisma.chatbotRequest.count({
          where: { tenantId: w.tenantId },
        }),
      ).toBe(0);
    });

    it('another product, another variant and another tenant each get their OWN decision', async () => {
      const a = await world();
      const b = await world();
      const secondProduct = randomUUID();
      await prisma.product.create({
        data: {
          id: secondProduct,
          tenantId: a.tenantId,
          name: 'Arena 10 kg',
          useStock: true,
          quantity: 0,
        },
      });
      await prisma.product.update({
        where: { id: a.productId },
        data: { hasVariants: true },
      });
      const variant = await prisma.variant.create({
        data: {
          productId: a.productId,
          tenantId: a.tenantId,
          name: 'Grande',
          sku: 'CRQ-18-G',
          quantity: 0,
        },
      });
      await waiting(a, 2); // product-level rows of the (now variant) product
      await waiting(a, 2, { variantId: variant.id, customerOffset: 2 });
      await waiting(a, 2, { productId: secondProduct, customerOffset: 4 });
      await waiting(b, 2);

      await tick();

      const forProduct = await reDecisions(a);
      expect(forProduct).toHaveLength(2);
      expect(forProduct.map((x) => x.variantId).sort()).toEqual(
        [null, variant.id].sort(),
      );
      expect(forProduct.find((x) => x.variantId === variant.id)?.sku).toBe(
        'CRQ-18-G',
      );
      expect(await reDecisions(a, secondProduct)).toHaveLength(1);
      expect(await reDecisions(b)).toHaveLength(1);
      // Each backorder is attached to ITS group's decision.
      const grouped = await prisma.backorder.groupBy({
        by: ['productId', 'variantId', 'reestimateDecisionId'],
        where: { tenantId: a.tenantId },
        _count: true,
      });
      expect(grouped).toHaveLength(3);
      expect(grouped.every((g) => g.reestimateDecisionId !== null)).toBe(true);
      expect(grouped.map((g) => g._count).sort()).toEqual([2, 2, 2]);
    });
  });

  // ---------------------------------------------------------------------------
  // Concurrency: one decision under concurrent ticks / replicas
  // ---------------------------------------------------------------------------

  describe('concurrency', () => {
    it('concurrent sweep ticks (replicas) over 5 overdue backorders still create ONE decision and attach each backorder once — 8 interleavings', async () => {
      for (let round = 0; round < 8; round++) {
        const w = await world();
        const rows = await waiting(w, 5);

        const results = await Promise.allSettled([
          tick(),
          tick(),
          tick(),
          tick(),
        ]);
        expect(deadlocks(results)).toEqual([]);
        expect(results.filter((r) => r.status === 'rejected')).toEqual([]);

        const decisions = await reDecisions(w);
        expect(decisions).toHaveLength(1);
        expect(
          await prisma.chatbotRequest.count({
            where: { tenantId: w.tenantId },
          }),
        ).toBe(1);
        for (const row of rows) {
          expect(await backorder(row.id)).toMatchObject({
            etaStage: 1,
            reestimateDecisionId: decisions[0].id,
          });
        }
        // Whoever created it, nobody failed (a lost unique race replays).
        const settled = results.map(
          (r) => (r as PromiseFulfilledResult<{ failed: number }>).value.failed,
        );
        expect(settled.every((failed) => failed === 0)).toBe(true);
        await dropTenants();
      }
    });

    it('concurrent ticks with the decision created directly (service level, no sweep batching) are one decision', async () => {
      const w = await world();
      await waiting(w, 5);
      const group = {
        tenantId: w.tenantId,
        productId: w.productId,
        variantId: null,
      };
      const outcomes = await Promise.all(
        Array.from({ length: 6 }, () =>
          inTenant(w, () => reestimate.requestForGroup(group, new Date())),
        ),
      );
      expect(await reDecisions(w)).toHaveLength(1);
      // Every backorder was attached exactly once across the racers.
      expect(outcomes.reduce((sum, o) => sum + o.attached, 0)).toBe(5);
      expect(outcomes.filter((o) => o.created).length).toBeLessThanOrEqual(1);
    });

    it('a decision resolved between its creation and the attach is never joined: the group moves on to the next round (deterministic race)', async () => {
      const w = await world();
      const [back] = await waiting(w, 1);
      const spy = jest.spyOn(intake, 'submit');
      spy.mockImplementationOnce(async (input, options) => {
        // Hand the real implementation back, then create the decision.
        spy.mockRestore();
        const created = await intake.submit(input, options);
        // Staff answer the brand-new decision before the attach transaction.
        await resolve(w, created.request.id, {
          action: 'PROVIDE_RESTOCK_ESTIMATE',
          restockDays: 2,
        });
        return created;
      });

      const outcome = await inTenant(w, () =>
        reestimate.requestForGroup(
          { tenantId: w.tenantId, productId: w.productId, variantId: null },
          new Date(),
        ),
      );

      const decisions = await reDecisions(w);
      expect(decisions.map((x) => x.status)).toEqual(['RESOLVED', 'PENDING']);
      expect(outcome).toEqual({ created: true, attached: 1 });
      // Not attached to the answered round 1 (it would never be answered).
      expect(await backorder(back.id)).toMatchObject({
        etaStage: 1,
        reestimateDecisionId: decisions[1].id,
      });
      expect(await etaItems(w)).toEqual([]);
    });

    it('a tick racing the staff resolution never strands a backorder: every one ends answered once (directly, or by the next round / repair) — 8 interleavings', async () => {
      for (let round = 0; round < 8; round++) {
        const w = await world();
        const first = await waiting(w, 3);
        await tick();
        const [decision] = await reDecisions(w);
        const late = await waiting(w, 2, { customerOffset: 3 });

        const results = await Promise.allSettled([
          tick(),
          new Promise((resolveDelay) =>
            setTimeout(resolveDelay, (round % 4) * 15),
          ).then(() =>
            resolve(w, decision.id, {
              action: 'PROVIDE_RESTOCK_ESTIMATE',
              restockDays: 4,
            }),
          ),
        ]);
        expect(deadlocks(results)).toEqual([]);
        expect(results.filter((r) => r.status === 'rejected')).toEqual([]);

        // Converge: a later tick opens the next round for whoever lost the race,
        // staff answer it, the repair covers the rest.
        await tick();
        for (const next of await reDecisions(w)) {
          if (next.status === 'PENDING') {
            await resolve(w, next.id, {
              action: 'PROVIDE_RESTOCK_ESTIMATE',
              restockDays: 4,
            });
          }
        }
        await tick();

        for (const row of [...first, ...late]) {
          const after = await backorder(row.id);
          expect(after.etaStage).toBe(2);
          expect(
            await etaItems(w, 'backorder.eta_updated', row.id),
          ).toHaveLength(1);
        }
        await dropTenants();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Resolution: the answer reaches every attached WAITING backorder, once
  // ---------------------------------------------------------------------------

  describe('the staff resolution fans out', () => {
    it('PROVIDE_RESTOCK_ESTIMATE: all 5 get the new estimatedAt and exactly one eta_updated each; no generic request.answered', async () => {
      const w = await world();
      const rows = await waiting(w, 5);
      await tick();
      const [decision] = await reDecisions(w);

      const resolved = await resolve(w, decision.id, {
        action: 'PROVIDE_RESTOCK_ESTIMATE',
        restockDays: 6,
      });
      expect(resolved.status).toBe('resolved');

      const stored = await prisma.humanDecision.findUniqueOrThrow({
        where: { id: decision.id },
      });
      const expected = new Date(stored.resolvedAt!.getTime() + 6 * DAY);
      for (const row of rows) {
        const after = await backorder(row.id);
        expect(after).toMatchObject({
          status: 'WAITING',
          etaStage: 2,
          estimatedArrivalDays: 6,
          version: row.version + 1,
        });
        expect(after.estimatedAt).toEqual(expected);
        const items = await etaItems(w, undefined, row.id);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
          type: 'backorder.eta_updated',
          requestId: null,
          saleId: null,
          backorderId: row.id,
          ackedAt: null,
        });
        expect(items[0].payload).toEqual({
          backorderId: row.id,
          folio: row.folio,
          productName: 'Croquetas Adulto 18 kg',
          variantName: null,
          quantity: 1,
          branchName: expect.stringMatching(/^Sucursal /) as string,
          customerFirstName: expect.stringMatching(/^Cliente\d$/) as string,
          version: row.version + 1,
          estimatedAt: expected.toISOString(),
          restockDays: 6,
        });
      }
      expect(await etaItems(w)).toHaveLength(5);
      // The staff-only request is closed with the decision and the bot gets no
      // generic `request.answered` (nobody on the bot side asked for it).
      expect(await wrapperOf(decision.id)).toMatchObject({
        status: 'RESOLVED',
      });
      expect(
        await prisma.chatbotFeedItem.count({
          where: { tenantId: w.tenantId, type: 'request.answered' },
        }),
      ).toBe(0);
      expect(
        (await allFeed(w)).every((item) => item.backorderId !== null),
      ).toBe(true);
    });

    it('REPORT_RESTOCK_ESTIMATE_UNAVAILABLE: all get eta_unavailable (no new estimate), etaStage 2, version bumped', async () => {
      const w = await world();
      const rows = await waiting(w, 3);
      await tick();
      const [decision] = await reDecisions(w);

      await resolve(w, decision.id, {
        action: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
      });

      for (const row of rows) {
        const after = await backorder(row.id);
        expect(after).toMatchObject({
          status: 'WAITING',
          etaStage: 2,
          estimatedArrivalDays: 7,
          version: row.version + 1,
        });
        // The estimate the customer was given at scheduling is untouched.
        expect(after.estimatedAt).toEqual(row.estimatedAt);
        const items = await etaItems(w, undefined, row.id);
        expect(items).toHaveLength(1);
        expect(items[0].type).toBe('backorder.eta_unavailable');
        expect(items[0].payload).toEqual({
          backorderId: row.id,
          folio: row.folio,
          productName: 'Croquetas Adulto 18 kg',
          variantName: null,
          quantity: 1,
          branchName: expect.stringMatching(/^Sucursal /) as string,
          customerFirstName: expect.stringMatching(/^Cliente\d$/) as string,
          version: row.version + 1,
        });
      }
    });

    it('a backorder that became RESERVED or CANCELLED meanwhile is skipped (no message); the WAITING ones are answered', async () => {
      const w = await world();
      const [stays, reserved, cancelled] = await waiting(w, 3);
      await tick();
      const [decision] = await reDecisions(w);
      await prisma.backorder.update({
        where: { id: reserved.id },
        data: {
          status: 'RESERVED',
          reservedAt: new Date(),
          reservedUntil: new Date(Date.now() + DAY),
          reminderAt: new Date(Date.now() + DAY - 3 * HOUR),
          currentPriceCents: 900,
          finalPriceCents: 900,
        },
      });
      await prisma.backorder.update({
        where: { id: cancelled.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledByKind: 'CUSTOMER',
        },
      });
      const reservedBefore = await backorder(reserved.id);
      const cancelledBefore = await backorder(cancelled.id);

      await resolve(w, decision.id, {
        action: 'PROVIDE_RESTOCK_ESTIMATE',
        restockDays: 3,
      });

      expect(await backorder(stays.id)).toMatchObject({ etaStage: 2 });
      expect(await etaItems(w, undefined, stays.id)).toHaveLength(1);
      expect(await backorder(reserved.id)).toEqual(reservedBefore);
      expect(await backorder(cancelled.id)).toEqual(cancelledBefore);
      expect(await etaItems(w, undefined, reserved.id)).toEqual([]);
      expect(await etaItems(w, undefined, cancelled.id)).toEqual([]);
    });

    it('a RESERVED backorder that falls back to WAITING (lost lot) is answered by the sweep repair, exactly once', async () => {
      const w = await world();
      const [back] = await waiting(w, 1);
      await tick();
      const [decision] = await reDecisions(w);
      await prisma.backorder.update({
        where: { id: back.id },
        data: {
          status: 'RESERVED',
          reservedAt: new Date(),
          reservedUntil: new Date(Date.now() + DAY),
          reminderAt: new Date(Date.now() + DAY - 3 * HOUR),
          currentPriceCents: 900,
          finalPriceCents: 900,
        },
      });
      await resolve(w, decision.id, {
        action: 'PROVIDE_RESTOCK_ESTIMATE',
        restockDays: 5,
      });
      expect(await etaItems(w)).toEqual([]);

      // The reservation is lost: back to WAITING, still attached (etaStage 1).
      await prisma.backorder.update({
        where: { id: back.id },
        data: {
          status: 'WAITING',
          reservedAt: null,
          reservedUntil: null,
          reminderAt: null,
          currentPriceCents: null,
          finalPriceCents: null,
        },
      });
      const total = await tick();
      expect(total.etaApplied).toBe(1);

      const after = await backorder(back.id);
      expect(after.etaStage).toBe(2);
      expect(await etaItems(w, 'backorder.eta_updated', back.id)).toHaveLength(
        1,
      );
      await tick();
      expect(await etaItems(w)).toHaveLength(1);
    });

    it('replaying the same resolution notifies nobody again: still one eta item per backorder', async () => {
      const w = await world();
      await waiting(w, 2);
      await tick();
      const [decision] = await reDecisions(w);
      const key = randomUUID();
      const first = await resolve(
        w,
        decision.id,
        { action: 'PROVIDE_RESTOCK_ESTIMATE', restockDays: 2 },
        key,
      );
      const replay = await resolve(
        w,
        decision.id,
        { action: 'PROVIDE_RESTOCK_ESTIMATE', restockDays: 2 },
        key,
      );
      expect(first.status).toBe('resolved');
      expect(replay.status).toBe('replayed');
      expect(await etaItems(w)).toHaveLength(2);
    });

    it('a failing listener never blocks the staff resolution; the sweep repair answers afterwards, once', async () => {
      const w = await world();
      const rows = await waiting(w, 2);
      await tick();
      const [decision] = await reDecisions(w);
      jest
        .spyOn(reestimate, 'onRestockResolved')
        .mockRejectedValueOnce(new Error('listener down'));

      const resolved = await resolve(w, decision.id, {
        action: 'PROVIDE_RESTOCK_ESTIMATE',
        restockDays: 9,
      });

      expect(resolved.status).toBe('resolved');
      expect(
        (
          await prisma.humanDecision.findUniqueOrThrow({
            where: { id: decision.id },
          })
        ).status,
      ).toBe('RESOLVED');
      for (const row of rows) {
        expect((await backorder(row.id)).etaStage).toBe(1);
      }
      expect(await etaItems(w)).toEqual([]);

      const total = await tick();
      expect(total.etaApplied).toBe(2);
      for (const row of rows) {
        expect((await backorder(row.id)).etaStage).toBe(2);
        expect(await etaItems(w, 'backorder.eta_updated', row.id)).toHaveLength(
          1,
        );
      }
      await tick();
      expect(await etaItems(w)).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Once only, and the next round
  // ---------------------------------------------------------------------------

  describe('once only (D6)', () => {
    it('an answered backorder that becomes overdue AGAIN (etaStage 2) is never re-asked', async () => {
      const w = await world();
      const [back] = await waiting(w, 1);
      await tick();
      const [decision] = await reDecisions(w);
      await resolve(w, decision.id, {
        action: 'PROVIDE_RESTOCK_ESTIMATE',
        restockDays: 1,
      });
      expect((await backorder(back.id)).etaStage).toBe(2);

      // Far in the future: the new estimate has passed too.
      await tick(new Date(Date.now() + 30 * DAY));

      expect(await reDecisions(w)).toHaveLength(1);
      expect((await backorder(back.id)).etaStage).toBe(2);
      expect(await etaItems(w)).toHaveLength(1);
    });

    it('round 2 opens for a backorder that became overdue AFTER round 1 was answered, with its own identity; the answered ones are untouched', async () => {
      const w = await world();
      const [first] = await waiting(w, 1);
      await tick();
      const [round1] = await reDecisions(w);
      await resolve(w, round1.id, {
        action: 'PROVIDE_RESTOCK_ESTIMATE',
        restockDays: 3,
      });
      const [late] = await waiting(w, 1, { customerOffset: 1 });

      await tick();

      const decisions = await reDecisions(w);
      expect(decisions).toHaveLength(2);
      const round2 = decisions[1];
      expect(round2.status).toBe('PENDING');
      expect(round2.sourceRequestId).toBe(
        reestimateSourceRequestId(w.tenantId, w.productId, null, 2),
      );
      expect(await backorder(late.id)).toMatchObject({
        etaStage: 1,
        reestimateDecisionId: round2.id,
      });
      expect(await backorder(first.id)).toMatchObject({
        etaStage: 2,
        reestimateDecisionId: round1.id,
      });
    });

    it('while no staff answer, the attached backorders stay WAITING with etaStage 1 and the customer hears nothing (RESTOCK has no expiry)', async () => {
      const w = await world();
      const [back] = await waiting(w, 1);
      await tick();
      await tick(new Date(Date.now() + 90 * DAY));
      expect(await backorder(back.id)).toMatchObject({
        status: 'WAITING',
        etaStage: 1,
      });
      const [decision] = await reDecisions(w);
      expect(decision.status).toBe('PENDING');
      expect(await allFeed(w)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // The existing RESTOCK flow is unchanged
  // ---------------------------------------------------------------------------

  describe('ordinary RESTOCK decisions (bot-created) are unchanged', () => {
    it('keeps the generic request.answered, an ordinary wrapper (no staff-only origin) and touches no backorder', async () => {
      const w = await world();
      const [overdue] = await waiting(w, 1);
      await prisma.chatbotConversation.create({
        data: {
          tenantId: w.tenantId,
          conversationRef: 'wa:5215512348801',
          customerKey: '525512348801',
        },
      });
      // The bot's own RESTOCK (the intake the bot route calls), same product.
      const created = await inTenant(w, () =>
        intake.submit({
          sourceRequestId: randomUUID(),
          productId: w.productId,
          productName: 'Croquetas Adulto 18 kg',
          requestedQuantity: 2,
          submittedCredentialId: 'bot-cred',
        }),
      );
      expect(created.status).toBe('created');
      const request = await wrapperOf(created.request.id);
      expect(request).toMatchObject({
        summary: 'Stock: Croquetas Adulto 18 kg',
        context: { productId: w.productId, variantId: null },
      });
      expect(request?.context).not.toHaveProperty('origin');

      await resolve(w, created.request.id, {
        action: 'PROVIDE_RESTOCK_ESTIMATE',
        restockDays: 5,
      });

      const answered = await prisma.chatbotFeedItem.findMany({
        where: { tenantId: w.tenantId, type: 'request.answered' },
      });
      expect(answered).toHaveLength(1);
      expect(answered[0].requestId).toBe(request!.id);
      expect(answered[0].payload).toMatchObject({
        action: 'PROVIDE_RESTOCK_ESTIMATE',
        restockDays: 5,
      });
      // The backorder module did not react to a decision it did not create.
      expect(await backorder(overdue.id)).toMatchObject({
        etaStage: 0,
        reestimateDecisionId: null,
        version: overdue.version,
      });
      expect(await etaItems(w)).toEqual([]);
    });

    it('a decision the sweep did not create is not a re-estimate: it is never joined by the sweep', async () => {
      const w = await world();
      await waiting(w, 1);
      const bot = await inTenant(w, () =>
        intake.submit({
          sourceRequestId: randomUUID(),
          productId: w.productId,
          productName: 'Croquetas Adulto 18 kg',
          submittedCredentialId: 'bot-cred',
        }),
      );
      await tick();
      const [reestimateDecision] = await reDecisions(w);
      expect(reestimateDecision.id).not.toBe(bot.request.id);
      expect(
        await prisma.backorder.count({
          where: {
            tenantId: w.tenantId,
            reestimateDecisionId: bot.request.id,
          },
        }),
      ).toBe(0);
    });

    it('a non-RESTOCK-estimate resolution of an unrelated decision never answers attached backorders', async () => {
      const w = await world();
      const [back] = await waiting(w, 1);
      await tick();
      const ordinary = await inTenant(w, () =>
        intake.submit({
          sourceRequestId: randomUUID(),
          productId: w.productId,
          productName: 'Croquetas Adulto 18 kg',
          submittedCredentialId: 'bot-cred',
        }),
      );
      await resolve(w, ordinary.request.id, {
        action: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
      });
      expect((await backorder(back.id)).etaStage).toBe(1);
      expect(await etaItems(w)).toEqual([]);
    });
  });
});
