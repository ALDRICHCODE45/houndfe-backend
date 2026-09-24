/**
 * APPLICATION SPEC: DeliveryThankYouSender — delivery-routes / DTE-4c.sender.
 * Pins the fail-closed identity gate, in-scope ordering (config → provenance →
 * summary → recipient), recipient authority (customer only; staff never leaks)
 * and no-cache retry semantics with typed in-memory mocks; no DB, no provider.
 */
import type { NotificationConfigView } from '../../notification-config/domain/notification-config';
import type { SendMailInput } from '../../notifications/email/mailer.port';
import type { SaleDeliverySummary } from '../domain/ports/sale-delivery-summary.port';
import {
  DeliveryThankYouSender,
  type DeliveryThankYouSkipReason,
} from './delivery-thank-you-sender';

const TENANT_ID = 'tenant-1';
const SALE_ID = 'sale-1';
const ROUTE_ID = 'route-1';
const STOP_ID = 'stop-1';
const CUSTOMER_EMAIL = 'ada@example.com';
const STAFF_EMAIL = 'staff@example.com';
const NEW_EMAIL = 'nueva@example.com';
const MERCHANT_NAME = 'Panadería HoundFe';
const SUBJECT = 'Gracias por tu compra';

const INPUT = {
  tenantId: TENANT_ID,
  saleId: SALE_ID,
  routeId: ROUTE_ID,
  stopId: STOP_ID,
};
const PADDED_INPUT = { ...INPUT, tenantId: ` ${TENANT_ID} ` };
const PROVENANCE_ARGS = {
  tenantId: TENANT_ID,
  routeId: ROUTE_ID,
  stopId: STOP_ID,
  saleId: SALE_ID,
};
const SALE_ARGS = { tenantId: TENANT_ID, saleId: SALE_ID };

type ProvenanceArgs = typeof PROVENANCE_ARGS;
type SaleArgs = { tenantId: string; saleId: string };

const SUMMARY: SaleDeliverySummary = {
  saleId: SALE_ID,
  folio: 'A-1001',
  confirmedAt: new Date('2026-08-01T12:00:00.000Z'),
  currency: 'MXN',
  subtotalCents: 25000,
  discountCents: 0,
  totalCents: 25000,
  customerName: 'Ada Lovelace',
  items: [
    {
      productName: 'Café molido',
      variantName: '500 g',
      quantity: 2,
      unitPriceCents: 12500,
      lineTotalCents: 25000,
      discountAmountCents: null,
      discountTitle: null,
      rewardKind: null,
    },
  ],
};

function configFixture(
  overrides: Partial<NotificationConfigView> = {},
): NotificationConfigView {
  return {
    enabled: true,
    recipients: [STAFF_EMAIL],
    enabledActions: ['DELIVERY_THANK_YOU'],
    ...overrides,
  };
}

const DISABLED_CONFIG = configFixture({ enabled: false });
const ACTIONLESS_CONFIG = configFixture({ enabledActions: ['LOW_STOCK'] });

function createHarness(merchantName: string | null = MERCHANT_NAME) {
  const find = jest.fn<Promise<NotificationConfigView>, []>();
  const hasCompletedRouteStop = jest.fn<Promise<boolean>, [ProvenanceArgs]>();
  const findConfirmedDeliveredSummary = jest.fn<
    Promise<SaleDeliverySummary | null>,
    [SaleArgs]
  >();
  const findEmailBySaleId = jest.fn<Promise<string | null>, [SaleArgs]>();
  const send = jest.fn<Promise<void>, [SendMailInput]>();
  // `runWithTenant` is generic and a `jest.Mock` is not, so the runner is a
  // typed recorder that executes the callback and logs each scope.
  const scopeCalls: string[] = [];
  const runWithTenant = <T>(
    tenantId: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    scopeCalls.push(tenantId);
    return fn();
  };
  find.mockResolvedValue(configFixture());
  hasCompletedRouteStop.mockResolvedValue(true);
  findConfirmedDeliveredSummary.mockResolvedValue(SUMMARY);
  findEmailBySaleId.mockResolvedValue(CUSTOMER_EMAIL);
  send.mockResolvedValue(undefined);
  const sender = new DeliveryThankYouSender({
    tenantRunner: { runWithTenant },
    notificationConfig: { find },
    stopProvenance: { hasCompletedRouteStop },
    summaryReader: { findConfirmedDeliveredSummary },
    customerEmailLookup: { findEmailBySaleId },
    mailer: { send },
    merchantName,
  });
  return {
    sender,
    find,
    hasCompletedRouteStop,
    findConfirmedDeliveredSummary,
    findEmailBySaleId,
    send,
    scopeCalls,
  };
}

type Harness = ReturnType<typeof createHarness>;

async function expectSkipped(
  h: Harness,
  reason: DeliveryThankYouSkipReason,
  input = INPUT,
): Promise<void> {
  await expect(h.sender.send(input)).resolves.toEqual({
    status: 'skipped',
    reason,
  });
}

describe('DeliveryThankYouSender', () => {
  const blankCases: Array<[keyof typeof INPUT, DeliveryThankYouSkipReason]> = [
    ['tenantId', 'missing-tenant'],
    ['saleId', 'missing-sale'],
    ['routeId', 'missing-route'],
    ['stopId', 'missing-stop'],
  ];

  it.each(blankCases)(
    'fails closed on a whitespace-only %s before scope or ports',
    async (field, reason) => {
      const h = createHarness();
      await expectSkipped(h, reason, { ...INPUT, [field]: '   ' });
      expect(h.scopeCalls).toEqual([]);
      expect(h.find).not.toHaveBeenCalled();
      expect(h.hasCompletedRouteStop).not.toHaveBeenCalled();
      expect(h.findConfirmedDeliveredSummary).not.toHaveBeenCalled();
      expect(h.findEmailBySaleId).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
    },
  );

  it.each<DeliveryThankYouSkipReason>([
    'master-disabled',
    'action-disabled',
    'no-summary',
    'no-email',
  ])('skips %s without sending', async (reason) => {
    const h = createHarness();
    if (reason === 'master-disabled') {
      h.find.mockResolvedValue(DISABLED_CONFIG);
    }
    if (reason === 'action-disabled') {
      h.find.mockResolvedValue(ACTIONLESS_CONFIG);
    }
    if (reason === 'no-summary') {
      h.findConfirmedDeliveredSummary.mockResolvedValue(null);
    }
    if (reason === 'no-email') h.findEmailBySaleId.mockResolvedValue(null);
    await expectSkipped(h, reason);
    if (reason === 'master-disabled' || reason === 'action-disabled') {
      expect(h.hasCompletedRouteStop).not.toHaveBeenCalled();
      expect(h.findConfirmedDeliveredSummary).not.toHaveBeenCalled();
      expect(h.findEmailBySaleId).not.toHaveBeenCalled();
    }
    expect(h.send).not.toHaveBeenCalled();
  });

  it('opens one scope, trims padded ids and passes the exact tuple in order', async () => {
    const h = createHarness();
    await h.sender.send(PADDED_INPUT);
    expect(h.scopeCalls).toEqual([TENANT_ID]);
    expect(h.hasCompletedRouteStop).toHaveBeenCalledWith(PROVENANCE_ARGS);
    expect(h.findConfirmedDeliveredSummary).toHaveBeenCalledWith(SALE_ARGS);
    expect(h.findEmailBySaleId).toHaveBeenCalledWith(SALE_ARGS);
    const probes = [
      h.find,
      h.hasCompletedRouteStop,
      h.findConfirmedDeliveredSummary,
      h.findEmailBySaleId,
      h.send,
    ].map((mock) => mock.mock.invocationCallOrder[0]);
    expect(probes).toEqual([...probes].sort((a, b) => a - b));
  });

  it('skips an unproven stop (POS-default DELIVERED) before summary or email', async () => {
    const h = createHarness();
    h.hasCompletedRouteStop.mockResolvedValue(false);
    await expectSkipped(h, 'provenance-unverified');
    expect(h.hasCompletedRouteStop).toHaveBeenCalledWith(PROVENANCE_ARGS);
    expect(h.findConfirmedDeliveredSummary).not.toHaveBeenCalled();
    expect(h.findEmailBySaleId).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('sends only to the customer with the DTE-3 body, ignoring staff and merchant-less', async () => {
    const h = createHarness();
    h.find.mockResolvedValue(
      configFixture({ recipients: [STAFF_EMAIL, 'otro@staff.test'] }),
    );
    await h.sender.send(INPUT);
    expect(h.send).toHaveBeenCalledTimes(1);
    const mail = h.send.mock.calls[0][0];
    expect(mail.to).toEqual([CUSTOMER_EMAIL]);
    expect(mail.subject).toBe(SUBJECT);
    expect(mail.html).toContain(SUBJECT);
    expect(mail.html).toContain('Ada Lovelace');
    expect(mail.html).toContain(MERCHANT_NAME);
    expect(mail.html).not.toContain(STAFF_EMAIL);
    const neutral = createHarness(null);
    await neutral.sender.send(INPUT);
    const neutralHtml = neutral.send.mock.calls[0][0].html;
    expect(neutralHtml).toContain('realizaste una compra');
    expect(neutralHtml).not.toContain(MERCHANT_NAME);
  });

  it('re-reads gate and recipient on every retry instead of caching them', async () => {
    const h = createHarness();
    h.send.mockRejectedValueOnce(new Error('smtp down'));
    await expect(h.sender.send(INPUT)).rejects.toThrow('smtp down');
    // A gate disabled after the failure must stop the retry send.
    h.find.mockResolvedValue(DISABLED_CONFIG);
    await expectSkipped(h, 'master-disabled');
    expect(h.send).toHaveBeenCalledTimes(1);
    // ...and a changed recipient is resolved again for the next send.
    h.find.mockResolvedValue(configFixture());
    h.findEmailBySaleId.mockResolvedValue(NEW_EMAIL);
    await h.sender.send(INPUT);
    expect(h.find).toHaveBeenCalledTimes(3);
    // The disabled retry stopped at the gate, so provenance ran only twice.
    expect(h.hasCompletedRouteStop).toHaveBeenCalledTimes(2);
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls[1][0].to).toEqual([NEW_EMAIL]);
  });
});
