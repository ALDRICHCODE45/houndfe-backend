import { emptyDocument } from '../domain/document';
import type { EditorialDocumentJson } from '../domain/editorial-document-mode';
import { assertFreshSaveCompatibilityV2 } from './editorial-save-compatibility-v2';

const adoptionValues = [null, 'legacy-to-v2'] as const;
const upgrade = 'EDITORIAL_CLIENT_UPGRADE_REQUIRED';
const legacy = () => ({ ...emptyDocument(), familyCode: 'deleted.family' });
const production = () => ({ schemaVersion: 2, ...emptyDocument(), facts: [] });
const key = (code: string) => ({ code, owner: 'product', variantId: null });
const historicalLegacy = () => ({
  ...legacy(),
  commercialTitle: ' ',
  description: '\ud800',
  mediaRefs: ['', 'deleted.asset'],
  values: [
    { ...key('text'), type: 'text', value: '' },
    { ...key('boolean'), type: 'boolean', value: false },
    { ...key('number'), type: 'number', value: -0, unit: null },
    { ...key('negative'), type: 'number', value: -12.5, unit: 'old.unit' },
    { ...key('single'), type: 'single', value: '' },
    { ...key('multi'), type: 'multi', value: ['', 'deleted.option'] },
  ],
});
const historicalProduction = () => {
  const value = {
    ...key('deleted.definition'),
    variantId: 'deleted.variant',
    state: 'known',
    payload: { type: 'range', min: 9, max: -1, unit: 'deleted.unit' },
    evidence: { sourceRef: '', verifiedOn: 'old-bad-date' },
  };
  const row = {
    variantId: null,
    presentation: '',
    declarations: [],
    careReview: null,
  };
  return {
    ...production(),
    description: '\ud800',
    mediaRefs: ['deleted', 'deleted'],
    values: [value, value],
    facts: [row, row],
  };
};

function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}

function rejectsExactly(run: () => void, message: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(Object.getPrototypeOf(caught)).toBe(Error.prototype);
  expect((caught as Error).message).toBe(message);
  expect(Object.keys(caught as Error)).toEqual([]);
}

function throwsIdentity(run: () => void, sentinel: unknown): void {
  let caught: unknown;
  let threw = false;
  try {
    run();
  } catch (error) {
    threw = true;
    caught = error;
  }
  expect(threw).toBe(true);
  expect(caught).toBe(sentinel);
}

describe('assertFreshSaveCompatibilityV2', () => {
  describe.each(adoptionValues)('adoption %s', (adoption) => {
    it.each([
      ['empty legacy', { ...emptyDocument() }],
      ['historical five payload types', historicalLegacy()],
    ])('requires explicit adoption for recognizable %s', (_name, document) => {
      const run = () => assertFreshSaveCompatibilityV2({ document }, adoption);
      if (adoption === 'legacy-to-v2') expect(run()).toBeUndefined();
      else rejectsExactly(run, 'MALFORMED');
    });

    it.each([
      ['empty production', production()],
      ['historical production conflicts', historicalProduction()],
    ])('forbids adoption for %s', (_name, document) => {
      const run = () => assertFreshSaveCompatibilityV2({ document }, adoption);
      if (adoption === null) expect(run()).toBeUndefined();
      else rejectsExactly(run, 'MALFORMED');
    });

    it.each<[string, EditorialDocumentJson]>([
      ['future version', { schemaVersion: 3 }],
      ['malformed V2', { ...production(), values: null }],
      [
        'wrong static axis namespace',
        {
          ...production(),
          facts: [
            {
              variantId: null,
              presentation: '',
              careReview: null,
              declarations: [
                {
                  key: 'relevantFitCodes',
                  state: 'known',
                  value: ['measure.equipment.power'],
                  evidence: { sourceRef: '', verifiedOn: 'old-bad-date' },
                  basis: '',
                },
              ],
            },
          ],
        },
      ],
    ])(
      'requires upgrade for unsupported %s before headers',
      (_name, document) => {
        rejectsExactly(
          () => assertFreshSaveCompatibilityV2({ document }, adoption),
          upgrade,
        );
      },
    );

    it.each<[string, EditorialDocumentJson]>([
      ['root {}', {}],
      ['present document null', null],
      ['string', 'old'],
      ['number', 4],
      ['boolean', false],
      ['array', []],
      ['unknown field', { ...legacy(), unknown: null }],
      [
        'duplicate identity',
        {
          ...legacy(),
          values: [
            { ...key('same'), type: 'text', value: 'one' },
            { ...key('same'), type: 'text', value: 'two' },
          ],
        },
      ],
      [
        'duplicate multi entries',
        {
          ...legacy(),
          values: [{ ...key('multi'), type: 'multi', value: ['x', 'x'] }],
        },
      ],
      [
        'product non-null variant',
        {
          ...legacy(),
          values: [
            { ...key('text'), variantId: 'old', type: 'text', value: '' },
          ],
        },
      ],
      [
        'family-null values',
        {
          ...emptyDocument(),
          values: [{ ...key('text'), type: 'text', value: '' }],
        },
      ],
    ])('requires upgrade for unrecognizable legacy %s', (_name, document) => {
      rejectsExactly(
        () => assertFreshSaveCompatibilityV2({ document }, adoption),
        upgrade,
      );
    });
  });

  it.each([
    ['legacy', historicalLegacy(), 'legacy-to-v2', null],
    ['production', historicalProduction(), null, 'legacy-to-v2'],
  ] as const)(
    'leaves frozen %s source unchanged after success and header failure',
    (_name, document, accepted, rejected) => {
      const source = { document };
      const before = structuredClone(source);
      const values = document.values;
      freeze(source);
      expect(assertFreshSaveCompatibilityV2(source, accepted)).toBeUndefined();
      rejectsExactly(
        () => assertFreshSaveCompatibilityV2(source, rejected),
        'MALFORMED',
      );
      expect(source).toEqual(before);
      expect(source.document).toBe(document);
      expect(document.values).toBe(values);
      expect(Object.isFrozen(values)).toBe(true);
    },
  );

  it('leaves frozen unrepresentable history intact on rejection', () => {
    const document = { ...historicalLegacy(), futureField: ['retain', -0] };
    const source = { document };
    const before = structuredClone(source);
    freeze(source);
    for (const adoption of adoptionValues)
      rejectsExactly(
        () => assertFreshSaveCompatibilityV2(source, adoption),
        upgrade,
      );
    expect(source).toEqual(before);
    expect(Object.is(document.futureField[1], -0)).toBe(true);
  });

  it('preserves numeric values including negative zero without fresh validation', () => {
    const document = historicalLegacy();
    expect(
      assertFreshSaveCompatibilityV2({ document }, 'legacy-to-v2'),
    ).toBeUndefined();
    expect(Object.is(document.values[2].value, -0)).toBe(true);
    expect(document.values[2]).toHaveProperty('unit', null);
    expect(document.values[3].value).toBe(-12.5);
  });

  describe.each([
    ['Error', new Error(upgrade)],
    ['TypeError', new TypeError('Expected a document shape V2')],
    ['non-Error', Object.freeze({ sentinel: true })],
  ])('unexpected %s propagation', (_name, sentinel) => {
    it.each(adoptionValues)(
      'propagates through classifier, adoption %s',
      (adoption) => {
        const document = new Proxy(production(), {
          getOwnPropertyDescriptor() {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error identity probe
            throw sentinel;
          },
        });
        throwsIdentity(
          () => assertFreshSaveCompatibilityV2({ document }, adoption),
          sentinel,
        );
      },
    );

    it('propagates through legacy recognition before missing-header rejection', () => {
      const document = new Proxy(legacy(), {
        getPrototypeOf() {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error identity probe
          throw sentinel;
        },
      });
      throwsIdentity(
        () => assertFreshSaveCompatibilityV2({ document }, null),
        sentinel,
      );
    });

    it('propagates through V2 recognition rather than treating it as unsupported', () => {
      const document = {
        ...production(),
        values: new Proxy([], {
          getPrototypeOf() {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error identity probe
            throw sentinel;
          },
        }),
      };
      throwsIdentity(
        () => assertFreshSaveCompatibilityV2({ document }, 'legacy-to-v2'),
        sentinel,
      );
    });
  });
});
