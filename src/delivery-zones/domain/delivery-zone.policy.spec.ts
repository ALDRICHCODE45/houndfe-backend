import { InvalidArgumentError } from '../../shared/domain/domain-error';
import {
  computeValidationUrgency,
  isValidZipCode,
  normalizeZoneSettings,
} from './delivery-zone.policy';

// shipping-zones / T1 (S1, S3) — zone shape and 24 h urgency rules.
describe('normalizeZoneSettings', () => {
  it('requires a positive surcharge and ETA for SURCHARGE', () => {
    expect(
      normalizeZoneSettings({
        type: 'SURCHARGE',
        surchargeCents: 4500,
        etaDays: 2,
      }),
    ).toEqual({ type: 'SURCHARGE', surchargeCents: 4500, etaDays: 2 });
    for (const bad of [
      { surchargeCents: undefined, etaDays: 2 },
      { surchargeCents: 0, etaDays: 2 },
      { surchargeCents: 10.5, etaDays: 2 },
      { surchargeCents: 4500, etaDays: undefined },
    ]) {
      expect(() =>
        normalizeZoneSettings({ type: 'SURCHARGE', ...bad }),
      ).toThrow(InvalidArgumentError);
    }
  });

  it('requires an ETA and forbids a surcharge for FREE', () => {
    expect(normalizeZoneSettings({ type: 'FREE', etaDays: 0 })).toEqual({
      type: 'FREE',
      surchargeCents: null,
      etaDays: 0,
    });
    expect(() =>
      normalizeZoneSettings({ type: 'FREE', etaDays: 1, surchargeCents: 1 }),
    ).toThrow(InvalidArgumentError);
    expect(() => normalizeZoneSettings({ type: 'FREE' })).toThrow(
      InvalidArgumentError,
    );
    expect(() => normalizeZoneSettings({ type: 'FREE', etaDays: 61 })).toThrow(
      InvalidArgumentError,
    );
  });

  it.each(['CARRIER_ONLY', 'DENIED'] as const)(
    'forbids surcharge and ETA for %s',
    (type) => {
      expect(normalizeZoneSettings({ type })).toEqual({
        type,
        surchargeCents: null,
        etaDays: null,
      });
      expect(() => normalizeZoneSettings({ type, etaDays: 3 })).toThrow(
        InvalidArgumentError,
      );
      expect(() => normalizeZoneSettings({ type, surchargeCents: 3 })).toThrow(
        InvalidArgumentError,
      );
    },
  );

  it('rejects an unknown type', () => {
    expect(() => normalizeZoneSettings({ type: 'PENDING' as never })).toThrow(
      InvalidArgumentError,
    );
  });
});

describe('isValidZipCode', () => {
  it('accepts exactly five digits', () => {
    expect(isValidZipCode('06700')).toBe(true);
    for (const bad of ['6700', '067000', '0670a', ' 06700', 6700]) {
      expect(isValidZipCode(bad)).toBe(false);
    }
  });
});

describe('computeValidationUrgency', () => {
  const lastMessage = new Date('2026-11-05T10:00:00.000Z');

  it('derives the 24 h WhatsApp deadline and the hours left', () => {
    const urgency = computeValidationUrgency(
      lastMessage,
      new Date('2026-11-05T16:30:00.000Z'),
    );
    expect(urgency).toEqual({
      deadlineAt: '2026-11-06T10:00:00.000Z',
      hoursLeft: 17.5,
      level: 'OK',
    });
  });

  it('flags WARNING under 12 h, CRITICAL under 4 h and EXPIRED at the deadline', () => {
    const at = (iso: string) =>
      computeValidationUrgency(lastMessage, new Date(iso)).level;
    expect(at('2026-11-05T22:00:01.000Z')).toBe('WARNING');
    expect(at('2026-11-06T06:00:01.000Z')).toBe('CRITICAL');
    expect(at('2026-11-06T10:00:00.000Z')).toBe('EXPIRED');
    expect(
      computeValidationUrgency(lastMessage, new Date('2026-11-07T00:00:00Z'))
        .hoursLeft,
    ).toBe(0);
  });
});
