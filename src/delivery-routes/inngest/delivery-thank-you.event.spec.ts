/**
 * SPEC: delivery-thank-you event contract — DTE-4b.event.
 *
 * Pins the dormant, ids-only wire contract and its parser. The module
 * must stay dependency-free: no database, client, mailer or DI graph is
 * reachable from it, and no PII may ever appear on the payload.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DELIVERY_THANK_YOU_NOTIFY_EVENT,
  DELIVERY_THANK_YOU_OUTBOX_TYPE,
  parseDeliveryThankYouEventPayload,
  type DeliveryThankYouEventPayload,
} from './delivery-thank-you.event';

/**
 * Compile-time PII guard (never executed): none of the forbidden
 * event-carried field names may exist on the payload contract. This
 * fails type-checking if someone later widens the payload.
 */
type ForbiddenEventField =
  | 'customerEmail'
  | 'customerName'
  | 'amountCents'
  | 'addresses'
  | 'idempotencyKey'
  | 'occurredAt';
type LeakedEventField = Extract<
  keyof DeliveryThankYouEventPayload,
  ForbiddenEventField
>;
type PayloadCarriesNoForbiddenField = [LeakedEventField] extends [never]
  ? true
  : false;
const PAYLOAD_CARRIES_NO_FORBIDDEN_FIELD: PayloadCarriesNoForbiddenField = true;
void PAYLOAD_CARRIES_NO_FORBIDDEN_FIELD;

const IDS = {
  tenantId: 'tenant-1',
  saleId: 'sale-1',
  routeId: 'route-1',
  stopId: 'stop-1',
} as const;

function validPayload(overrides: Record<string, unknown> = {}) {
  return { ...IDS, ...overrides };
}

describe('delivery-thank-you event contract (DTE-4b.event)', () => {
  it('pins the trigger and the outbox type exactly', () => {
    expect(DELIVERY_THANK_YOU_NOTIFY_EVENT).toBe('delivery/thank-you.notify');
    expect(DELIVERY_THANK_YOU_OUTBOX_TYPE).toBe('delivery.thank_you.notify');
  });

  it('accepts a full ids-only payload and returns exactly the four ids', () => {
    const parsed = parseDeliveryThankYouEventPayload(validPayload());
    expect(parsed).toEqual(IDS);
    expect(Object.keys(parsed as object)).toEqual([
      'tenantId',
      'saleId',
      'routeId',
      'stopId',
    ]);
  });

  it('rejects non-object input', () => {
    expect(parseDeliveryThankYouEventPayload(null)).toBeNull();
    expect(parseDeliveryThankYouEventPayload(undefined)).toBeNull();
    expect(parseDeliveryThankYouEventPayload('tenant-1')).toBeNull();
    expect(parseDeliveryThankYouEventPayload(7)).toBeNull();
    expect(parseDeliveryThankYouEventPayload([])).toBeNull();
  });

  it.each(['tenantId', 'saleId', 'routeId', 'stopId'])(
    'rejects a missing %s',
    (field) => {
      const payload: Record<string, unknown> = validPayload();
      delete payload[field];
      expect(parseDeliveryThankYouEventPayload(payload)).toBeNull();
    },
  );

  it.each(['tenantId', 'saleId', 'routeId', 'stopId'])(
    'rejects a non-string %s',
    (field) => {
      for (const bad of [7, null, { id: 'x' }, ['x'], true]) {
        expect(
          parseDeliveryThankYouEventPayload(validPayload({ [field]: bad })),
        ).toBeNull();
      }
    },
  );

  it.each(['tenantId', 'saleId', 'routeId', 'stopId'])(
    'rejects a blank/whitespace %s',
    (field) => {
      for (const blank of ['', '   ', '\n\t ']) {
        expect(
          parseDeliveryThankYouEventPayload(validPayload({ [field]: blank })),
        ).toBeNull();
      }
    },
  );

  it.each(['tenantId', 'saleId', 'routeId', 'stopId'])(
    'preserves a padded %s verbatim (no silent normalization)',
    (field) => {
      const padded = '  padded-1  ';
      expect(
        parseDeliveryThankYouEventPayload(validPayload({ [field]: padded })),
      ).toEqual({ ...IDS, [field]: padded });
    },
  );

  it('ignores extra untrusted properties, including email, and copies nothing', () => {
    const untrusted = validPayload({
      customerEmail: 'attacker@example.com',
      customerName: 'Ada Lovelace',
      amountCents: 25000,
      addresses: ['Calle 1'],
      idempotencyKey: 'seed',
      occurredAt: '2026-08-01T00:00:00.000Z',
    });
    const parsed = parseDeliveryThankYouEventPayload(untrusted);

    expect(parsed).toEqual(IDS);
    expect(parsed).not.toBe(untrusted);
    expect(parsed).not.toHaveProperty('customerEmail');
    expect(parsed).not.toHaveProperty('customerName');
    expect(Object.keys(parsed as object)).toHaveLength(4);
  });

  it('is dormant and dependency-free: no imports, no DB, client or mailer', () => {
    const source = readFileSync(
      join(__dirname, 'delivery-thank-you.event.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/\brequire\(/);
    expect(source).not.toMatch(/prisma|PrismaService|@nestjs/i);
    expect(source).not.toMatch(/createFunction|registerFunctions/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });
});
