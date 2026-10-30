import * as evidence from './editorial-evidence-v2';
import { evaluateFactRuleV2 } from './editorial-fact-rule-evaluation-v2';
import type { KnownPayloadV2 } from './editorial-known-payload-shape-v2';
import type { RuleResultV2 } from './editorial-option-case-evaluation-v2';
import { assertSelectedBindingReadinessV2 as assertReady } from './editorial-selected-binding-readiness-v2';
import type { ValueV2 } from './editorial-value-shape-v2';

const fresh = { sourceRef: ' manufacturer page ', verifiedOn: '2024-02-29' };
const key = {
  code: 'custom.assertion',
  owner: 'sellable' as const,
  variantId: 'v1',
};
function result(overrides: Partial<RuleResultV2> = {}): RuleResultV2 {
  return {
    applicability: 'applicable',
    required: false,
    allowNA: false,
    evidenceRequired: true,
    documentary: 'resolved',
    ...overrides,
  };
}
function known(
  payload: KnownPayloadV2 = { type: 'boolean', value: false },
  source: evidence.EvidenceV2 | null = fresh,
): ValueV2 {
  return { ...key, state: 'known', payload, evidence: source };
}
function nonknown(state: 'unknown' | 'not_applicable'): ValueV2 {
  return { ...key, state, evidence: null };
}
function rejects(selected: RuleResultV2 | null, value?: ValueV2): void {
  expect(() => assertReady(selected, value)).toThrow(/^MALFORMED$/);
}
const emptyPayloads: KnownPayloadV2[] = [
  { type: 'single', value: '' },
  { type: 'text', value: '' },
  { type: 'text', value: ' \t\r\n\u00a0\ufeff' },
  { type: 'multi', value: [] },
];
const presentPayloads: KnownPayloadV2[] = [
  { type: 'single', value: 'option.code' },
  { type: 'text', value: ' \u00a0 factual text \ufeff' },
  { type: 'text', value: '\u200b' },
  { type: 'text', value: '\u0085' },
  { type: 'multi', value: ['option.code'] },
  { type: 'boolean', value: false },
  { type: 'boolean', value: true },
  { type: 'number', value: 0, unit: null },
  { type: 'number', value: -2, unit: 'unit' },
  { type: 'range', min: -4, max: -1, unit: 'unit' },
  { type: 'range', min: 0, max: 0, unit: 'unit' },
];

afterEach(() => jest.restoreAllMocks());

describe('selected binding local readiness V2 (S35/S45)', () => {
  it.each([undefined, nonknown('unknown'), known()])(
    'rejects an unresolved selection regardless of assignment: %j',
    (value) => rejects(null, value),
  );

  it.each([
    undefined,
    nonknown('unknown'),
    nonknown('not_applicable'),
    known(),
  ])('rejects unresolved applicability regardless of assignment: %j', (value) =>
    rejects(result({ applicability: 'unresolved', allowNA: true }), value),
  );

  it.each([
    undefined,
    nonknown('unknown'),
    nonknown('not_applicable'),
    known(),
  ])(
    'rejects unresolved documentary metadata regardless of assignment: %j',
    (value) => rejects(result({ documentary: 'unresolved' }), value),
  );

  it('accepts documentary not_applicable without waiving required or evidence checks', () => {
    const selected = result({ documentary: 'not_applicable', required: true });
    expect(() => assertReady(selected, known())).not.toThrow();
    rejects(selected);
    rejects(selected, known(undefined, null));
  });

  it.each([undefined, nonknown('unknown'), nonknown('not_applicable')])(
    'requires a known assignment for required policies: %j',
    (value) => rejects(result({ required: true }), value),
  );

  it.each(emptyPayloads)('rejects required empty payload %j', (payload) => {
    rejects(result({ required: true }), known(payload));
  });

  it.each(presentPayloads)('accepts required local presence %j', (payload) => {
    expect(() =>
      assertReady(result({ required: true }), known(payload)),
    ).not.toThrow();
  });

  it.each(['not_applicable', 'unresolved'] as const)(
    'required cannot be satisfied when applicability is %s',
    (applicability) => {
      rejects(
        result({ required: true, applicability, allowNA: true }),
        known(),
      );
    },
  );

  it.each(['applicable', 'not_applicable'] as const)(
    'allows optional absent/unknown with resolved applicability %s',
    (applicability) => {
      const selected = result({ applicability });
      expect(() => assertReady(selected, undefined)).not.toThrow();
      expect(() => assertReady(selected, nonknown('unknown'))).not.toThrow();
    },
  );

  it.each([...emptyPayloads, ...presentPayloads])(
    'optional known payload still needs its own evidence: %j',
    (payload) => {
      expect(() => assertReady(result(), known(payload))).not.toThrow();
      rejects(result(), known(payload, null));
    },
  );

  it.each([...emptyPayloads, ...presentPayloads])(
    'known contradicts selected not_applicable even for false/empty: %j',
    (payload) => {
      rejects(
        result({ applicability: 'not_applicable', allowNA: true }),
        known(payload),
      );
    },
  );

  it.each([
    ['applicable', false],
    ['applicable', true],
    ['not_applicable', false],
    ['unresolved', true],
  ] as const)(
    'forbids explicit NA for %s / allowNA %s',
    (applicability, allowNA) => {
      rejects(result({ applicability, allowNA }), nonknown('not_applicable'));
    },
  );

  it('admits explicit NA only with N + allowNA, without impossible value evidence', () => {
    const selected = result({ applicability: 'not_applicable', allowNA: true });
    const predicate = jest.spyOn(evidence, 'isFreshEvidenceV2');
    expect(() =>
      assertReady(selected, nonknown('not_applicable')),
    ).not.toThrow();
    expect(predicate).not.toHaveBeenCalled();
  });

  it.each([...emptyPayloads, ...presentPayloads])(
    'permits null evidence for known payload when evidenceRequired is false: %j',
    (payload) => {
      expect(() =>
        assertReady(result({ evidenceRequired: false }), known(payload, null)),
      ).not.toThrow();
    },
  );

  it.each([
    { sourceRef: '', verifiedOn: fresh.verifiedOn },
    { sourceRef: ' \u00a0', verifiedOn: fresh.verifiedOn },
    { sourceRef: 'x\u0000y', verifiedOn: fresh.verifiedOn },
    { sourceRef: '\ud800', verifiedOn: fresh.verifiedOn },
    { sourceRef: 'x'.repeat(1001), verifiedOn: fresh.verifiedOn },
    { sourceRef: 'page', verifiedOn: '2023-02-29' },
    { sourceRef: 'page', verifiedOn: '2024-2-29' },
    { sourceRef: 'page', verifiedOn: '0000-01-01' },
  ])(
    'rejects malformed supplied evidence even with flag false: %j',
    (source) => {
      for (const evidenceRequired of [true, false]) {
        rejects(result({ evidenceRequired }), known(undefined, source));
      }
    },
  );

  it('uses the existing fresh predicate with the exact per-value evidence', () => {
    const predicate = jest.spyOn(evidence, 'isFreshEvidenceV2');
    expect(() => assertReady(result(), known())).not.toThrow();
    expect(predicate).toHaveBeenCalledWith(fresh);
  });

  it('does not add a recency clock or normalize valid evidence', () => {
    const source = Object.freeze({
      sourceRef: ' page ',
      verifiedOn: '9999-12-31',
    });
    expect(() => assertReady(result(), known(undefined, source))).not.toThrow();
    expect(source).toEqual({ sourceRef: ' page ', verifiedOn: '9999-12-31' });
  });

  it('preserves frozen selected/value/payload/evidence on acceptance and rejection', () => {
    const payload = Object.freeze({
      type: 'text' as const,
      value: ' \ufeff text \u00a0',
    });
    const selected = Object.freeze(result({ required: true }));
    const value = Object.freeze(known(payload, Object.freeze({ ...fresh })));
    const before = structuredClone({ selected, value });
    expect(() => assertReady(selected, value)).not.toThrow();
    rejects(
      Object.freeze({ ...selected, applicability: 'not_applicable' }),
      value,
    );
    expect({ selected, value }).toEqual(before);
    expect(payload.value).toBe(' \ufeff text \u00a0');
  });

  it('does not mutate frozen multi arrays', () => {
    const payload: KnownPayloadV2 = { type: 'multi', value: ['b', 'a'] };
    Object.freeze(payload.value);
    Object.freeze(payload);
    const value = Object.freeze(known(payload));
    expect(() =>
      assertReady(Object.freeze(result({ required: true })), value),
    ).not.toThrow();
    expect(payload.value).toEqual(['b', 'a']);
  });

  it.each([
    new RangeError('dependency'),
    new TypeError('MALFORMED'),
    'sentinel',
  ])(
    'propagates unexpected evidence dependency failure by identity: %j',
    (failure) => {
      jest.spyOn(evidence, 'isFreshEvidenceV2').mockImplementation(() => {
        // Preserve non-Error dependency failures by identity as well.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw failure;
      });
      try {
        assertReady(result(), known());
        throw new Error('Expected dependency failure');
      } catch (error) {
        expect(error).toBe(failure);
      }
    },
  );
});

describe('real qualified fact-result composition (S46, local gate only)', () => {
  const rule = {
    family: 'accessory',
    ruleId: 'optional_equipment',
    parameter: 'measure.equipment.power',
  } as const;

  function equipment(source: evidence.EvidenceV2 | null = fresh): ValueV2 {
    return {
      ...known({ type: 'number', value: 0, unit: 'W' }, source),
      code: rule.parameter,
    };
  }

  it('negative electrical fact selects N: known fails, explicit NA passes', () => {
    const selected = evaluateFactRuleV2(rule, { electricalApplies: false });
    expect(selected.applicability).toBe('not_applicable');
    rejects(selected, equipment());
    expect(() =>
      assertReady(selected, {
        ...nonknown('not_applicable'),
        code: rule.parameter,
      }),
    ).not.toThrow();
  });

  it('required equipment with unknown relevance selects U and fails', () => {
    const selected = evaluateFactRuleV2(
      { ...rule, family: 'habitat', ruleId: 'equipment' },
      {},
    );
    expect(selected.applicability).toBe('unresolved');
    rejects(selected, equipment());
  });

  it('S46 unknown accessory relevance selects O; evidenced known passes only this gate', () => {
    const selected = evaluateFactRuleV2(rule, {});
    expect(selected).toEqual(result());
    expect(() => assertReady(selected, equipment())).not.toThrow();
    rejects(selected, equipment(null));
  });
});
