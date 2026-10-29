import { emptyDocument } from './document';
import {
  classifyEditorialDocumentMode,
  type EditorialDocumentJson,
  type EditorialDocumentMode,
} from './editorial-document-mode';
import { isRecognizableLegacyDocument } from './editorial-legacy-document-recognition';

const documentV2 = () => ({ schemaVersion: 2, ...emptyDocument(), facts: [] });
const evidence = { sourceRef: '\ud800', verifiedOn: 'not-a-date' };
const withAxis = (code: string) => ({
  ...documentV2(),
  facts: [
    {
      variantId: 'deleted',
      presentation: '',
      declarations: [
        {
          key: 'relevantFitCodes',
          state: 'known',
          value: [code],
          evidence,
          basis: '',
        },
      ],
      careReview: null,
    },
  ],
});

function freeze(value: EditorialDocumentJson): void {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}

const legacyCases: EditorialDocumentJson[] = [
  {},
  { ...emptyDocument() },
  { commercialTitle: 42, values: 'malformed' },
  { ...emptyDocument(), familyCode: null, values: [{ unexpected: true }] },
  null,
  false,
  true,
  0,
  -1.5,
  1e100,
  '',
  '2',
  [],
  [null, true, { schemaVersion: 2 }],
];

describe('classifyEditorialDocumentMode', () => {
  it.each(legacyCases.map((input, index) => ({ input, index })))(
    'classifies unversioned JSON case $index as legacy without adoption checks',
    ({ input }) => {
      expect(classifyEditorialDocumentMode(input)).toBe('legacy');
    },
  );

  it('distinguishes historical legacy mode from legacy adoptability', () => {
    expect(classifyEditorialDocumentMode({})).toBe('legacy');
    expect(isRecognizableLegacyDocument({})).toBe(false);
  });

  it('recognizes a complete empty V2, including numeric 2.0', () => {
    const mode: EditorialDocumentMode = classifyEditorialDocumentMode({
      ...documentV2(),
      schemaVersion: 2.0,
    });
    expect(mode).toBe('production-v2');
  });

  it.each([0, 1, 3, -2, 2.1, '2', '2.0', '', null, false])(
    'does not coerce or default explicit version %p',
    (schemaVersion) => {
      expect(
        classifyEditorialDocumentMode({ ...documentV2(), schemaVersion }),
      ).toBe('unsupported');
    },
  );

  it.each([
    { schemaVersion: 2 },
    { ...documentV2(), facts: null },
    { ...documentV2(), extra: true },
    withAxis('unknown.axis'),
  ])(
    'rejects malformed versioned shapes and invalid static axes: %p',
    (input) => {
      expect(classifyEditorialDocumentMode(input)).toBe('unsupported');
    },
  );

  it('requires every V2 root key, without filling defaults', () => {
    for (const key of Object.keys(emptyDocument()).concat('facts')) {
      const input: Record<string, EditorialDocumentJson> = documentV2();
      delete input[key];
      expect(classifyEditorialDocumentMode(input)).toBe('unsupported');
    }
  });

  it('preserves frozen conflicts, stale references, historical strings and order', () => {
    const value = {
      code: 'unknown.definition',
      owner: 'product',
      variantId: 'deleted',
      state: 'known',
      evidence,
      payload: { type: 'range', min: 9, max: -1, unit: 'unknown.unit' },
    };
    const requirement = {
      key: '',
      description: '',
      disposition: 'conflicting',
      evidence: [],
      basis: '',
    };
    const row = {
      variantId: 'deleted',
      presentation: '\ud800',
      declarations: withAxis('measure.fit.neck').facts[0].declarations,
      careReview: {
        state: 'prepared',
        jurisdiction: '',
        intendedUse: '',
        determination: 'none_applicable',
        evidence: [evidence, evidence],
        basis: '',
        requirements: [requirement, requirement],
        warnings: [
          {
            key: '',
            requirementKeys: ['dangling'],
            text: '',
            disclosure: 'public_required',
            evidence: [],
            handlingBasis: '',
          },
        ],
      },
    };
    const input = {
      ...documentV2(),
      commercialTitle: ' '.repeat(3001),
      description: '\ud800',
      mediaRefs: ['z', 'a', 'z'],
      values: [value, value],
      facts: [row, row],
    };
    freeze(input);
    const before = JSON.stringify(input);
    const keys = Object.keys(input);
    expect(classifyEditorialDocumentMode(input)).toBe('production-v2');
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.keys(input)).toEqual(keys);
    expect(input.values[0]).toBe(value);
    expect(input.facts[0]).toBe(row);
    expect(input.facts[0].declarations).toBe(row.declarations);
    expect(Object.isFrozen(input)).toBe(true);
  });

  // Defensive reflection cases below are deliberately outside ordinary decoded JSON.
  it('never executes a schemaVersion accessor', () => {
    const getter = jest.fn(() => 2);
    const input = Object.defineProperty(documentV2(), 'schemaVersion', {
      get: getter,
    });
    expect(classifyEditorialDocumentMode(input)).toBe('unsupported');
    expect(getter).not.toHaveBeenCalled();
  });

  it('does not count an inherited version as an own version', () => {
    const input = {};
    Object.setPrototypeOf(input, { schemaVersion: 2 });
    expect(classifyEditorialDocumentMode(input)).toBe('legacy');
  });

  it.each([new Error('reflection'), new TypeError('shape'), 'non-error'])(
    'propagates own-version descriptor failure unchanged: %p',
    (failure) => {
      const input = new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- identity includes non-Error throws
            throw failure;
          },
        },
      );
      try {
        classifyEditorialDocumentMode(input);
        throw new Error('Expected failure');
      } catch (error) {
        expect(error).toBe(failure);
      }
    },
  );

  it.each([new Error('reflection'), new TypeError('shape'), 'non-error'])(
    'propagates recognizer reflection failure unchanged: %p',
    (failure) => {
      const input = new Proxy(documentV2(), {
        ownKeys() {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- identity includes non-Error throws
          throw failure;
        },
      });
      try {
        classifyEditorialDocumentMode(input);
        throw new Error('Expected failure');
      } catch (error) {
        expect(error).toBe(failure);
      }
    },
  );
});
