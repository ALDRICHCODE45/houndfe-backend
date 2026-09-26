/**
 * INTEGRATION SPEC: DB-backed delivery thank-you sender — delivery-routes / DTE-6c.
 *
 * Exercises three production Prisma adapters on local `postgres-test`: a
 * CONFIRMED POS sale defaults to DELIVERED, but no email is authorized without
 * the exact tenant/route/stop/sale tuple, COMPLETED status and both timestamps.
 * With that persisted proof, the fake mailer receives snapshot HTML and the
 * current customer address, never staff recipients. Catalog changes, foreign
 * identities and partial timestamps are checked. Fixture rows are synthetic
 * adapter states, NOT a route created/checked in through the domain service;
 * DTE-6b separately proves the real check-in transaction. No Resend or boot.
 */
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  BASELINE_TENANT_ID,
  disconnectIntegrationPrisma,
  resetAndSeedBaseline,
} from '../../../test/integration/reset-db';
import {
  DeliveryThankYouSender,
  type DeliveryThankYouSendInput,
  type DeliveryThankYouSkipReason,
} from '../application/delivery-thank-you-sender';
import { formatMxnCents } from '../../notifications/email/templates/delivery-thank-you.email';
import type { NotificationConfigView } from '../../notification-config/domain/notification-config';
import type { SendMailInput } from '../../notifications/email/mailer.port';
import { PrismaSaleDeliveryStopProvenanceRepository } from './prisma-sale-delivery-stop-provenance.repository';
import { PrismaSaleDeliverySummaryRepository } from './prisma-sale-delivery-summary.repository';
import { PrismaSaleCustomerEmailRepository } from './prisma-sale-customer-email.repository';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

const STAFF_EMAIL = 'staff@test.local';
const MERCHANT_NAME = 'Panadería HoundFe';
const SUBJECT = 'Gracias por tu compra';
const SNAPSHOT_PRODUCT_NAME = 'Café molido';
const SNAPSHOT_TOTAL_CENTS = 25_000;
const CHECKED_IN_AT = new Date('2026-08-01T15:00:00.000Z');
const COMPLETED_AT = new Date('2026-08-01T15:05:00.000Z');

/** Opt-in config fixture; `recipients` is the STAFF list the sender must ignore. */
const optInConfig = (): NotificationConfigView => ({
  enabled: true,
  recipients: [STAFF_EMAIL, 'otro-staff@test.local'],
  enabledActions: ['DELIVERY_THANK_YOU'],
});

describeIfDb('DeliveryThankYouSender (Integration - Real DB)', () => {
  let prisma: PrismaService;
  let sender: DeliveryThankYouSender;
  let summaryReader: PrismaSaleDeliverySummaryRepository;
  let mailerSend: jest.Mock<Promise<void>, [SendMailInput]>;
  let scopeCalls: string[];
  let config: NotificationConfigView;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    await resetAndSeedBaseline();

    scopeCalls = [];
    config = optInConfig();
    mailerSend = jest.fn<Promise<void>, [SendMailInput]>();
    mailerSend.mockResolvedValue(undefined);
    summaryReader = new PrismaSaleDeliverySummaryRepository(prisma);

    sender = new DeliveryThankYouSender({
      // Fresh, uncached scope per invocation. These three ports scope every
      // read by the explicit tenantId, so no CLS context is needed.
      tenantRunner: {
        runWithTenant: <T>(tenantId: string, fn: () => Promise<T>) => {
          scopeCalls.push(tenantId);
          return fn();
        },
      },
      notificationConfig: { find: () => Promise.resolve(config) },
      stopProvenance: new PrismaSaleDeliveryStopProvenanceRepository(prisma),
      summaryReader,
      customerEmailLookup: new PrismaSaleCustomerEmailRepository(prisma),
      mailer: { send: mailerSend },
      merchantName: MERCHANT_NAME,
    });
  });

  afterEach(async () => {
    scopeCalls.length = 0;
    mailerSend.mockReset();
    mailerSend.mockResolvedValue(undefined);
    config = optInConfig();
    await resetAndSeedBaseline();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await disconnectIntegrationPrisma();
  });

  // ── Fixtures ───────────────────────────────────────────────────────────

  interface Graph {
    tenantId: string;
    driverId: string;
    customerId: string;
    productId: string;
    saleId: string;
    folio: string;
    customerEmail: string;
  }

  /**
   * Seed the minimal tenant-scoped graph: cashier + driver, a customer with an
   * owned shipping address, a catalog product, and a CONFIRMED POS sale whose
   * `deliveryStatus` is left to the schema DEFAULT (DELIVERED) — the exact
   * false-positive the sender must survive. The address belongs to the same
   * tenant, but DELIVERED is NOT route-create eligible; the completed-stop
   * fixture below is a synthetic adapter state, not a simulated check-in.
   * The persisted SaleItem snapshot is written with the sale.
   */
  async function seedGraph(opts: { email?: string } = {}): Promise<Graph> {
    const tenantId = BASELINE_TENANT_ID;
    const cashierId = randomUUID();
    const driverId = randomUUID();
    for (const [id, name] of [
      [cashierId, 'Cashier'],
      [driverId, 'Driver'],
    ] as const) {
      await prisma.user.create({
        data: { id, email: `${id}@test.local`, hashedPassword: 'x', name },
      });
    }
    const customerEmail = opts.email ?? 'maria@test.local';
    const customerId = randomUUID();
    await prisma.customer.create({
      data: {
        id: customerId,
        firstName: 'María',
        lastName: 'Gómez',
        email: customerEmail,
        tenantId,
      },
    });
    const addressId = randomUUID();
    await prisma.customerAddress.create({
      data: {
        id: addressId,
        customerId,
        tenantId,
        street: 'Av. Reforma',
        exteriorNumber: '123',
      },
    });
    const productId = randomUUID();
    await prisma.product.create({
      data: { id: productId, name: SNAPSHOT_PRODUCT_NAME, tenantId },
    });
    const saleId = randomUUID();
    const folio = `A-202608-${randomUUID().slice(0, 6).toUpperCase()}`;
    await prisma.sale.create({
      data: {
        id: saleId,
        userId: cashierId,
        customerId,
        shippingAddressId: addressId,
        tenantId,
        status: 'CONFIRMED',
        channel: 'POS',
        folio,
        subtotalCents: SNAPSHOT_TOTAL_CENTS,
        discountCents: 0,
        totalCents: SNAPSHOT_TOTAL_CENTS,
        // deliveryStatus intentionally omitted → schema default DELIVERED.
      },
    });
    await prisma.saleItem.create({
      data: {
        saleId,
        productId,
        productName: SNAPSHOT_PRODUCT_NAME,
        quantity: 2,
        unitPriceCents: 12_500,
        tenantId,
      },
    });
    return {
      tenantId,
      driverId,
      customerId,
      productId,
      saleId,
      folio,
      customerEmail,
    };
  }

  /** Persist a route + one stop with the requested status and timestamps. */
  async function seedStop(
    g: Graph,
    stop: {
      status?: 'PENDING' | 'COMPLETED';
      checkedInAt?: Date | null;
      completedAt?: Date | null;
    } = {},
  ): Promise<{ routeId: string; stopId: string }> {
    const routeId = randomUUID();
    await prisma.deliveryRoute.create({
      data: {
        id: routeId,
        tenantId: g.tenantId,
        driverUserId: g.driverId,
        status: stop.status === 'COMPLETED' ? 'COMPLETED' : 'ACTIVE',
        startedAt: CHECKED_IN_AT,
        completedAt: stop.status === 'COMPLETED' ? COMPLETED_AT : null,
      },
    });
    const stopId = randomUUID();
    await prisma.deliveryRouteStop.create({
      data: {
        id: stopId,
        tenantId: g.tenantId,
        routeId,
        saleId: g.saleId,
        sortOrder: 0,
        status: stop.status ?? 'PENDING',
        checkedInAt: stop.checkedInAt ?? null,
        completedAt: stop.completedAt ?? null,
      },
    });
    return { routeId, stopId };
  }

  /** The only authorizing shape: COMPLETED with BOTH timestamps present. */
  function seedCompletedStop(
    g: Graph,
  ): Promise<{ routeId: string; stopId: string }> {
    return seedStop(g, {
      status: 'COMPLETED',
      checkedInAt: CHECKED_IN_AT,
      completedAt: COMPLETED_AT,
    });
  }

  function inputFor(
    g: Graph,
    stop: { routeId: string; stopId: string },
  ): DeliveryThankYouSendInput {
    return {
      tenantId: g.tenantId,
      saleId: g.saleId,
      routeId: stop.routeId,
      stopId: stop.stopId,
    };
  }

  async function expectSkipped(
    input: DeliveryThankYouSendInput,
    reason: DeliveryThankYouSkipReason,
  ): Promise<void> {
    const result = await sender.send(input);
    expect(result).toEqual({ status: 'skipped', reason });
    expect(mailerSend).not.toHaveBeenCalled();
  }

  // ── (1) POS default DELIVERED is not proof ─────────────────────────────

  it('skips provenance-unverified for a POS-default DELIVERED sale with no route stop', async () => {
    const g = await seedGraph();
    // The summary IS persisted — the skip is provenance, not a missing read.
    await expect(
      summaryReader.findConfirmedDeliveredSummary({
        tenantId: g.tenantId,
        saleId: g.saleId,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        saleId: g.saleId,
        totalCents: SNAPSHOT_TOTAL_CENTS,
      }),
    );

    await expectSkipped(
      inputFor(g, { routeId: randomUUID(), stopId: randomUUID() }),
      'provenance-unverified',
    );
  });

  it('skips provenance-unverified for a PENDING stop', async () => {
    const g = await seedGraph();
    const stop = await seedStop(g, { status: 'PENDING' });
    await expectSkipped(inputFor(g, stop), 'provenance-unverified');
  });

  // ── (2) Exact COMPLETED stop authorizes the send ───────────────────────

  it('sends the persisted snapshot + current email when the exact stop is COMPLETED', async () => {
    const g = await seedGraph();
    const stop = await seedCompletedStop(g);

    await expect(sender.send(inputFor(g, stop))).resolves.toEqual({
      status: 'sent',
    });

    expect(scopeCalls).toEqual([g.tenantId]);
    expect(mailerSend).toHaveBeenCalledTimes(1);
    const mail = mailerSend.mock.calls[0][0];
    expect(mail.to).toEqual([g.customerEmail]);
    expect(mail.subject).toBe(SUBJECT);
    expect(mail.html).toContain(SNAPSHOT_PRODUCT_NAME);
    expect(mail.html).toContain(g.folio);
    expect(mail.html).toContain(formatMxnCents(SNAPSHOT_TOTAL_CENTS));
    // Staff config recipients are never a customer address.
    expect(mail.to).not.toContain(STAFF_EMAIL);
    expect(mail.html).not.toContain(STAFF_EMAIL);
  });

  it('renders the SaleItem snapshot even after the catalog product is renamed', async () => {
    const g = await seedGraph();
    const stop = await seedCompletedStop(g);
    await prisma.product.update({
      where: { id: g.productId },
      data: { name: 'Nombre nuevo del catálogo' },
    });

    await sender.send(inputFor(g, stop));

    const html = mailerSend.mock.calls[0][0].html;
    expect(html).toContain(SNAPSHOT_PRODUCT_NAME);
    expect(html).not.toContain('Nombre nuevo del catálogo');
  });

  it('re-resolves the customer email at send time instead of caching it', async () => {
    const g = await seedGraph({ email: 'antes@test.local' });
    const stop = await seedCompletedStop(g);

    await sender.send(inputFor(g, stop));
    expect(mailerSend.mock.calls[0][0].to).toEqual(['antes@test.local']);

    await prisma.customer.update({
      where: { id: g.customerId },
      data: { email: 'despues@test.local' },
    });

    await sender.send(inputFor(g, stop));
    expect(mailerSend).toHaveBeenCalledTimes(2);
    expect(mailerSend.mock.calls[1][0].to).toEqual(['despues@test.local']);
  });

  const mismatchFields = ['saleId', 'routeId', 'stopId'] as const;

  it.each(mismatchFields)('cannot authorize a mismatched %s', async (field) => {
    const g = await seedGraph();
    const stop = await seedCompletedStop(g);
    const input = { ...inputFor(g, stop), [field]: randomUUID() };
    await expectSkipped(input, 'provenance-unverified');
  });

  it('cannot authorize a foreign tenant for a baseline-tenant stop', async () => {
    const g = await seedGraph();
    const stop = await seedCompletedStop(g);
    const foreignTenantId = randomUUID();
    await prisma.tenant.create({
      data: {
        id: foreignTenantId,
        name: 'Foreign Tenant',
        slug: `foreign-${randomUUID()}`,
      },
    });

    await expectSkipped(
      { ...inputFor(g, stop), tenantId: foreignTenantId },
      'provenance-unverified',
    );
  });

  // ── (3) Fail closed on partial provenance ──────────────────────────────

  const partialTimestampCases: Array<
    [string, { checkedInAt: Date | null; completedAt: Date | null }]
  > = [
    ['checkedInAt', { checkedInAt: null, completedAt: COMPLETED_AT }],
    ['completedAt', { checkedInAt: CHECKED_IN_AT, completedAt: null }],
  ];

  it.each(partialTimestampCases)(
    'fails closed when a COMPLETED stop is missing %s',
    async (_field, timestamps) => {
      const g = await seedGraph();
      const stop = await seedStop(g, { status: 'COMPLETED', ...timestamps });
      await expectSkipped(inputFor(g, stop), 'provenance-unverified');
    },
  );
});
