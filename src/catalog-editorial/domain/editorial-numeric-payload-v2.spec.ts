import type { KnownPayloadV2 } from './editorial-known-payload-shape-v2';
import type { NumericPolicyV2 } from './editorial-vocabulary-numeric-v2';
import { assertFreshNumericPayloadV2 as assertNumeric } from './editorial-numeric-payload-v2';

type Payload = Extract<KnownPayloadV2, { type: 'number' | 'range' }>;
type Resolved = Extract<NumericPolicyV2, { status: 'resolved' }>;
const pending: NumericPolicyV2 = { status: 'pending' };
function resolved(overrides: Partial<Resolved> = {}): Resolved {
  return {
    status: 'resolved',
    magnitude: 'custom',
    integer: false,
    lower: null,
    lowerInclusive: false,
    upper: null,
    upperInclusive: false,
    ...overrides,
  };
}
const scalar = (value: number, unit: string | null = null): Payload => ({
  type: 'number',
  value,
  unit,
});
const range = (min: number, max: number, unit = 'cm'): Payload => ({
  type: 'range',
  min,
  max,
  unit,
});
function reject(
  payload: Payload,
  policy: NumericPolicyV2,
  operation: 'save' | 'publish',
) {
  let caught: unknown;
  try {
    assertNumeric(payload, policy, operation);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(Object.getPrototypeOf(caught)).toBe(Error.prototype);
  expect((caught as Error).message).toBe('MALFORMED');
}

describe('pending numeric policy (S33)', () => {
  it.each([scalar(-2.5), scalar(0), scalar(-0), range(-3.5, 0), range(0, 0)])(
    'allows incomplete %p on save only',
    (payload) => {
      expect(assertNumeric(payload, pending, 'save')).toBeUndefined();
      reject(payload, pending, 'publish');
    },
  );
  it('rejects reversed ranges even on pending save', () => {
    reject(range(2, 1), pending, 'save');
  });
  it('preserves frozen pending policy and payload through save and publish', () => {
    const policy = Object.freeze({ ...pending });
    const payload = Object.freeze(range(-0, +0));
    expect(assertNumeric(payload, policy, 'save')).toBeUndefined();
    reject(payload, policy, 'publish');
    expect(policy).toEqual({ status: 'pending' });
    expect(payload).toEqual(range(-0, +0));
  });
});

describe.each(['save', 'publish'] as const)(
  'resolved numeric %s domain',
  (operation) => {
    it.each([
      ['lower', true, 2, false],
      ['lower', true, 3, true],
      ['lower', true, 4, true],
      ['lower', false, 2, false],
      ['lower', false, 3, false],
      ['lower', false, 4, true],
      ['upper', true, 2, true],
      ['upper', true, 3, true],
      ['upper', true, 4, false],
      ['upper', false, 2, true],
      ['upper', false, 3, false],
      ['upper', false, 4, false],
    ] as const)(
      '%s inclusive=%s at %s accepted=%s',
      (side, inclusive, value, accepted) => {
        const policy = resolved({ [side]: 3, [`${side}Inclusive`]: inclusive });
        // Each endpoint must satisfy the same rule as a scalar.
        const inside = side === 'lower' ? 5 : 1;
        const payloads = [scalar(value), range(value, value)];
        payloads.push(
          side === 'lower' ? range(value, inside) : range(inside, value),
        );
        for (const payload of payloads) {
          if (accepted)
            expect(assertNumeric(payload, policy, operation)).toBeUndefined();
          else reject(payload, policy, operation);
        }
      },
    );

    it('checks the opposite range endpoint too, not only min/lower and max/upper', () => {
      reject(
        range(1, 2),
        resolved({ lower: 3, lowerInclusive: true }),
        operation,
      );
      reject(
        range(4, 5),
        resolved({ upper: 3, upperInclusive: true }),
        operation,
      );
    });

    it('applies both bounds together and admits a singleton domain', () => {
      const policy = resolved({
        lower: 3,
        lowerInclusive: true,
        upper: 3,
        upperInclusive: true,
      });
      for (const payload of [scalar(3), range(3, 3)])
        expect(assertNumeric(payload, policy, operation)).toBeUndefined();
      for (const payload of [scalar(2), scalar(4), range(2, 3), range(3, 4)])
        reject(payload, policy, operation);
    });

    it('treats independently absent and both absent bounds as unbounded', () => {
      for (const payload of [
        scalar(-Number.MAX_VALUE),
        range(-Number.MAX_VALUE, -1),
      ])
        expect(
          assertNumeric(
            payload,
            resolved({ upper: 0, upperInclusive: true }),
            operation,
          ),
        ).toBeUndefined();
      for (const payload of [
        scalar(Number.MAX_VALUE),
        range(1, Number.MAX_VALUE),
      ])
        expect(
          assertNumeric(
            payload,
            resolved({ lower: 0, lowerInclusive: true }),
            operation,
          ),
        ).toBeUndefined();
      expect(
        assertNumeric(
          range(-Number.MAX_VALUE, Number.MAX_VALUE),
          resolved(),
          operation,
        ),
      ).toBeUndefined();
    });

    it.each([scalar(1.5), range(1.5, 3), range(1, 2.5)])(
      'applies integer to %p without rounding',
      (payload) => {
        reject(payload, resolved({ integer: true }), operation);
        expect(assertNumeric(payload, resolved(), operation)).toBeUndefined();
      },
    );
    it('has no safe-integer ceiling', () => {
      const value = Number.MAX_SAFE_INTEGER + 1;
      for (const payload of [scalar(value), range(value, value)])
        expect(
          assertNumeric(payload, resolved({ integer: true }), operation),
        ).toBeUndefined();
    });
    it('enforces positive count through explicit bounds and integer flag', () => {
      const policy = resolved({ magnitude: 'count', integer: true, lower: 0 });
      for (const value of [0, -0, -1, 0.5])
        reject(scalar(value, 'piece'), policy, operation);
      expect(
        assertNumeric(scalar(1, 'piece'), policy, operation),
      ).toBeUndefined();
    });
    it('compares both signs of zero equally and preserves their identities', () => {
      for (const side of ['lower', 'upper'] as const) {
        const inclusive = resolved({ [side]: 0, [`${side}Inclusive`]: true });
        const exclusive = resolved({ [side]: 0 });
        for (const payload of [
          scalar(-0),
          scalar(+0),
          range(-0, +0),
          range(+0, -0),
        ]) {
          const before = { ...payload };
          Object.freeze(payload);
          expect(assertNumeric(payload, inclusive, operation)).toBeUndefined();
          reject(payload, exclusive, operation);
          expect(payload).toEqual(before);
          if (payload.type === 'number')
            expect(
              Object.is(payload.value, (before as typeof payload).value),
            ).toBe(true);
          else {
            expect(Object.is(payload.min, (before as typeof payload).min)).toBe(
              true,
            );
            expect(Object.is(payload.max, (before as typeof payload).max)).toBe(
              true,
            );
          }
        }
      }
    });
    it('allows equal ranges but rejects reversed ranges regardless of policy bounds', () => {
      expect(
        assertNumeric(range(-2, -2), resolved(), operation),
      ).toBeUndefined();
      reject(range(2, -2), resolved(), operation);
    });
    it.each(['equipment', 'fit', 'temperature', 'count', 'positive-only'])(
      'does not infer a domain from magnitude %s',
      (magnitude) => {
        const policy = resolved({ magnitude });
        for (const payload of [
          scalar(-2.5, 'W'),
          scalar(0, 'V'),
          range(-5, 0, '°C'),
          range(-2, 0, 'cm'),
        ])
          expect(assertNumeric(payload, policy, operation)).toBeUndefined();
      },
    );
    it.each([null, 'cm', 'mm', 'unrecognized-here'])(
      'does not convert or recheck admitted unit %p',
      (unit) => {
        const policy = resolved({
          lower: 2,
          lowerInclusive: true,
          upper: 2,
          upperInclusive: true,
        });
        expect(
          assertNumeric(scalar(2, unit), policy, operation),
        ).toBeUndefined();
        reject(scalar(0.2, unit), policy, operation);
        if (unit !== null)
          expect(
            assertNumeric(range(2, 2, unit), policy, operation),
          ).toBeUndefined();
      },
    );
    it('leaves frozen success and failure inputs unchanged', () => {
      const policy = Object.freeze(resolved({ integer: true }));
      for (const [payload, accepted] of [
        [scalar(-0, ' W '), true],
        [range(-3, 0), true],
        [scalar(1.5), false],
        [range(2, 1), false],
      ] as const) {
        const before = { ...payload };
        Object.freeze(payload);
        if (accepted)
          expect(assertNumeric(payload, policy, operation)).toBeUndefined();
        else reject(payload, policy, operation);
        expect(payload).toEqual(before);
      }
      expect(policy).toEqual(resolved({ integer: true }));
    });
  },
);
