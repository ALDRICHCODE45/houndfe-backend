import { InvalidArgumentError } from '../../shared/domain/domain-error';
import {
  DELIVERY_ZONE_TYPE,
  hashDeliveryZoneIntake,
  parseDeliveryZoneIntakeRequest,
} from './delivery-zone-intake.request';

const SOURCE_REQUEST_ID = '6f1c2b8e-3a4d-4e5f-9a0b-1c2d3e4f5a6b';

function body(overrides: Record<string, unknown> = {}) {
  return {
    sourceRequestId: SOURCE_REQUEST_ID,
    type: 'DELIVERY_ZONE',
    zipCode: '06700',
    state: 'Ciudad de México',
    municipality: 'Cuauhtémoc',
    neighborhood: 'Roma Norte',
    phoneCountryCode: '52',
    phone: '5512345678',
    conversationRef: 'wa:conv-123',
    lastCustomerMessageAt: '2026-11-05T10:00:00.000Z',
    ...overrides,
  };
}

const NOW = new Date('2026-11-05T10:05:00.000Z');

describe('parseDeliveryZoneIntakeRequest', () => {
  it('parses the exact body and keeps the raw id for the header match', () => {
    const parsed = parseDeliveryZoneIntakeRequest(
      body({
        sourceRequestId: SOURCE_REQUEST_ID.toUpperCase(),
        neighborhood: '  Roma   Norte ',
      }),
      NOW,
    );
    expect(parsed).toEqual({
      sourceRequestId: SOURCE_REQUEST_ID,
      originalSourceRequestId: SOURCE_REQUEST_ID.toUpperCase(),
      type: DELIVERY_ZONE_TYPE,
      zipCode: '06700',
      state: 'Ciudad de México',
      municipality: 'Cuauhtémoc',
      neighborhood: 'Roma Norte',
      phoneCountryCode: '52',
      phone: '5512345678',
      conversationRef: 'wa:conv-123',
      lastCustomerMessageAt: new Date('2026-11-05T10:00:00.000Z'),
    });
  });

  it.each([
    ['an extra key', { tenantId: 'x' }],
    ['a bad zip', { zipCode: '6700' }],
    ['a blank state', { state: '   ' }],
    ['a control char', { municipality: 'Cuau\u0007htémoc' }],
    ['a bad phone', { phone: '55 1234' }],
    ['a plus country code', { phoneCountryCode: '+52' }],
    ['a long conversationRef', { conversationRef: 'x'.repeat(201) }],
    ['a non-ISO time', { lastCustomerMessageAt: '2026-11-05 10:00' }],
    ['a future time', { lastCustomerMessageAt: '2026-11-05T10:30:00.000Z' }],
    ['a nil uuid', { sourceRequestId: '00000000-0000-0000-0000-000000000000' }],
  ])('rejects %s with a value-free error', (_label, overrides) => {
    expect(() => parseDeliveryZoneIntakeRequest(body(overrides), NOW)).toThrow(
      InvalidArgumentError,
    );
  });

  it('rejects a missing key and a non-object body', () => {
    const missing: Record<string, unknown> = body();
    delete missing.phone;
    expect(() => parseDeliveryZoneIntakeRequest(missing, NOW)).toThrow(
      InvalidArgumentError,
    );
    expect(() => parseDeliveryZoneIntakeRequest([], NOW)).toThrow(
      InvalidArgumentError,
    );
  });
});

describe('hashDeliveryZoneIntake', () => {
  it('is stable for the same content and changes with any field', () => {
    const a = parseDeliveryZoneIntakeRequest(body(), NOW);
    const b = parseDeliveryZoneIntakeRequest(
      body({ sourceRequestId: SOURCE_REQUEST_ID.toUpperCase() }),
      NOW,
    );
    const c = parseDeliveryZoneIntakeRequest(
      body({ phone: '5599999999' }),
      NOW,
    );
    expect(hashDeliveryZoneIntake(a)).toBe(hashDeliveryZoneIntake(b));
    expect(hashDeliveryZoneIntake(a)).not.toBe(hashDeliveryZoneIntake(c));
  });
});
