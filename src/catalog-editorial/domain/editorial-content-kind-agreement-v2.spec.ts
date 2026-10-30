import { assertContentKindAgreementV2 as assertAgreement } from './editorial-content-kind-agreement-v2';
import type { FactInputsV2 } from './editorial-fact-rule-evaluation-v2';
import type { KnownPayloadV2 } from './editorial-known-payload-shape-v2';
import { INVENTORY } from './editorial-production-choice-inventory';
import { parseValueShapeV2, type ValueV2 } from './editorial-value-shape-v2';

type Magnitude = NonNullable<FactInputsV2['contentMagnitude']>;
const mappings: readonly (readonly [string, Magnitude])[] = [
  ['content.kind.mass', 'mass'],
  ['content.kind.volume', 'volume'],
  ['content.kind.count', 'count'],
  ['content.kind.length', 'length'],
  ['content.kind.area', 'area'],
];
const magnitudes = mappings.map(([, magnitude]) => magnitude);
const key = {
  code: 'content.kind',
  owner: 'sellable' as const,
  variantId: 'v1',
};
// Shape parsing is real; current metadata/reference and subject admission are
// caller preconditions, not duplicated by this local agreement predicate.
function known(optionCode: string): ValueV2 {
  return parseValueShapeV2({
    ...key,
    state: 'known',
    payload: { type: 'single', value: optionCode },
    evidence: null,
  });
}
function nonknown(state: 'unknown' | 'not_applicable'): ValueV2 {
  return parseValueShapeV2({ ...key, state, evidence: null });
}
function rejects(
  kind: ValueV2,
  magnitude: FactInputsV2['contentMagnitude'],
): void {
  expect(() => assertAgreement(kind, magnitude)).toThrow(/^MALFORMED$/);
}

describe('canonical content-kind local agreement V2 (S35/S45/S52)', () => {
  it('pins the five exact inventory codes independently of their labels', () => {
    const codes = INVENTORY.filter(([code]) => code === 'content.kind').flatMap(
      ([, group, , pairs]) =>
        pairs.split('; ').map((pair) => `${group}.${pair.split('=')[0]}`),
    );
    expect(codes).toEqual(mappings.map(([code]) => code));
  });

  describe.each(mappings)('%s', (optionCode, expectedMagnitude) => {
    it.each(magnitudes)(
      'compares against qualified magnitude %s',
      (magnitude) => {
        const kind = known(optionCode);
        if (magnitude === expectedMagnitude) {
          expect(() => assertAgreement(kind, magnitude)).not.toThrow();
        } else {
          rejects(kind, magnitude);
        }
      },
    );

    it.each([undefined, null])(
      'requires a known magnitude even in an otherwise optional context: %j',
      (magnitude) => rejects(known(optionCode), magnitude),
    );
  });

  it('does not turn an unknown qualified fact into agreement for an optional kind binding', () => {
    // Unknown declarations project to an omitted input; no required-policy
    // argument exists here because S52 applies even when capture is optional.
    const qualifiedFacts: FactInputsV2 = {};
    rejects(known('content.kind.mass'), qualifiedFacts.contentMagnitude);
  });

  describe.each([
    ['absent', undefined],
    ['unknown', nonknown('unknown')],
    ['explicit NA', nonknown('not_applicable')],
  ] as const)('%s kind', (_label, kind) => {
    it.each([...magnitudes, undefined, null])(
      'skips comparison against %j without granting NA admission',
      (magnitude) => {
        expect(() => assertAgreement(kind, magnitude)).not.toThrow();
      },
    );
  });

  it.each([
    'content.kind.extra',
    'content.kind.mass.extra',
    'content.kind.massive',
    'custom.content.kind.mass',
    'mass',
    'Masa',
    'Superficie',
    'content.kind.MASS',
    'CONTENT.KIND.MASS',
    ' content.kind.mass',
    'content.kind.mass ',
    'content.kind',
  ])(
    'never infers agreement for an unmapped extra/alias/prefix: %s',
    (code) => {
      // These may be valid extra option identities in admitted metadata. The
      // spelling/label is not an explicit magnitude mapping, even in custom.
      for (const magnitude of magnitudes) rejects(known(code), magnitude);
      rejects(known(code), undefined);
      rejects(known(code), null);
    },
  );

  it.each(['product', 'sellable'] as const)(
    'retains canonical meaning for custom-family %s assignments',
    (owner) => {
      // No family discriminator: canonical identity means the same thing in
      // custom metadata. Caller already selected matching subject facts.
      const kind = parseValueShapeV2({
        ...known('content.kind.area'),
        owner,
        variantId: owner === 'product' ? null : 'custom-variant',
      });
      expect(() => assertAgreement(kind, 'area')).not.toThrow();
      rejects(kind, 'length');
      rejects(kind, undefined);
    },
  );

  it.each<KnownPayloadV2>([
    { type: 'text', value: 'content.kind.mass' },
    { type: 'multi', value: ['content.kind.mass'] },
    { type: 'boolean', value: false },
    { type: 'number', value: 1, unit: 'g' },
    { type: 'range', min: 1, max: 2, unit: 'g' },
  ])(
    'does not silently skip an encountered non-single known payload: %j',
    (payload) => {
      // Deliberately violate the reference-admitted single-choice precondition;
      // follow the existing option-case evaluator's TypeError guard convention.
      const kind = parseValueShapeV2({
        ...key,
        state: 'known',
        payload,
        evidence: null,
      });
      expect(() => assertAgreement(kind, 'mass')).toThrow(TypeError);
    },
  );

  it('preserves frozen matching and mismatching inputs, including per-value evidence', () => {
    const kind = known('content.kind.volume');
    if (kind.state !== 'known') throw new Error('Expected known fixture');
    kind.evidence = {
      sourceRef: 'manufacturer',
      verifiedOn: '2024-02-29',
    };
    Object.freeze(kind.payload);
    Object.freeze(kind.evidence);
    Object.freeze(kind);
    const facts = Object.freeze<FactInputsV2>({ contentMagnitude: 'volume' });
    const before = JSON.stringify({ kind, facts });
    expect(() => assertAgreement(kind, facts.contentMagnitude)).not.toThrow();
    rejects(kind, 'count');
    rejects(kind, null);
    expect(JSON.stringify({ kind, facts })).toBe(before);
  });

  it('uses the existing exact plain MALFORMED error contract', () => {
    expect.assertions(3);
    try {
      assertAgreement(known('content.kind.mass'), 'area');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
      expect((error as Error).message).toBe('MALFORMED');
    }
  });
});
