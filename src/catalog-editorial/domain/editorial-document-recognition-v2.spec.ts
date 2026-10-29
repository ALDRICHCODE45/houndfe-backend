import { emptyDocument } from './document';
import { isRecognizableDocumentV2 } from './editorial-document-recognition-v2';
import { EditorialDocumentShapeError } from './editorial-document-shape-error';
import { parseDocumentShapeV2 } from './editorial-document-shape-v2';

const axes = [
  [
    'relevantDimensionCodes',
    [
      'measure.dimensions.external_length',
      'measure.dimensions.external_width',
      'measure.dimensions.external_height',
      'measure.dimensions.external_diameter',
      'measure.dimensions.internal_length',
      'measure.dimensions.internal_width',
      'measure.dimensions.internal_height',
      'measure.dimensions.internal_diameter',
    ],
  ],
  [
    'relevantFitCodes',
    ['measure.fit.neck', 'measure.fit.chest', 'measure.fit.back_length'],
  ],
  [
    'relevantCapacityCodes',
    ['measure.capacity.container', 'measure.capacity.habitat_usable_volume'],
  ],
  [
    'relevantEquipmentCodes',
    [
      'measure.equipment.power',
      'measure.equipment.voltage',
      'measure.equipment.frequency',
      'measure.equipment.flow',
      'measure.equipment.temperature',
    ],
  ],
] as const;
const evidence = { sourceRef: '\ud800', verifiedOn: 'not-a-date' };
const document = () => ({ schemaVersion: 2, ...emptyDocument(), facts: [] });
const known = (key: string, value: unknown) => ({
  key,
  state: 'known',
  value,
  evidence,
  basis: '',
});
const withDeclarations = (declarations: unknown[]) => ({
  ...document(),
  facts: [
    { variantId: 'deleted', presentation: '', declarations, careReview: null },
  ],
});
const axis = (key: string, codes: readonly string[]) =>
  known(
    key,
    key === 'relevantDimensionCodes'
      ? { codes, toyTypes: ['unknown.toy'] }
      : codes,
  );

function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}

describe('isRecognizableDocumentV2', () => {
  it('recognizes empty V2 but not empty objects or legacy empty documents', () => {
    expect(isRecognizableDocumentV2(document())).toBe(true);
    expect(isRecognizableDocumentV2({})).toBe(false);
    expect(isRecognizableDocumentV2(emptyDocument())).toBe(false);
  });

  describe.each(axes)('%s static union', (key, codes) => {
    it.each(codes)('accepts exact literal %s', (code) => {
      expect(
        isRecognizableDocumentV2(withDeclarations([axis(key, [code])])),
      ).toBe(true);
    });
    it.each(['unknown', 'MEASURE.FIT.NECK', 'neck', ' measure.fit.neck'])(
      'rejects unknown/alias %s',
      (code) => {
        expect(
          isRecognizableDocumentV2(withDeclarations([axis(key, [code])])),
        ).toBe(false);
      },
    );
    it('rejects wrong namespaces and case/spacing aliases of its own literals', () => {
      const foreign =
        key === 'relevantFitCodes'
          ? 'measure.equipment.power'
          : 'measure.fit.neck';
      for (const code of [foreign, codes[0].toUpperCase(), ` ${codes[0]}`])
        expect(
          isRecognizableDocumentV2(withDeclarations([axis(key, [code])])),
        ).toBe(false);
    });
    it('accepts unknown state and empty or duplicate subsets beyond fresh bounds', () => {
      for (const declaration of [
        { key, state: 'unknown', evidence: null },
        axis(key, []),
        axis(key, Array<string>(20).fill(codes[0])),
      ])
        expect(isRecognizableDocumentV2(withDeclarations([declaration]))).toBe(
          true,
        );
    });
  });

  it('preserves frozen historical conflicts and strings, returning only true', () => {
    const requirement = {
      key: '',
      description: '',
      disposition: 'conflicting',
      evidence: [evidence, evidence],
      basis: '',
    };
    const warning = {
      key: '',
      requirementKeys: ['dangling', 'dangling'],
      text: '',
      disclosure: 'public_required',
      evidence: [],
      handlingBasis: '',
    };
    const review = {
      state: 'prepared',
      jurisdiction: '',
      intendedUse: '',
      determination: 'none_applicable',
      evidence: [evidence, evidence],
      basis: '',
      requirements: [requirement, requirement],
      warnings: [warning, warning],
    };
    const declarations = [
      axis('relevantFitCodes', ['measure.fit.neck']),
      known('optionalNonpertinenceCodes', ['unknown.route', 'unknown.route']),
    ];
    const row = {
      variantId: 'deleted',
      presentation: '\ud800',
      declarations: [...declarations, ...declarations],
      careReview: review,
    };
    const value = {
      code: 'unknown.definition',
      owner: 'product',
      variantId: 'deleted',
      state: 'known',
      evidence,
      payload: { type: 'range', min: 9, max: -1, unit: 'unknown.unit' },
    };
    const input = {
      ...document(),
      commercialTitle: ' '.repeat(3001),
      description: '\ud800',
      mediaRefs: ['missing', 'missing'],
      values: Array(201).fill(value) as unknown[],
      facts: Array(201).fill(row) as unknown[],
    };
    freeze(input);
    const before = JSON.stringify(input);
    expect(isRecognizableDocumentV2(input)).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
    expect(input.values[0]).toBe(value);
    expect(input.facts[0]).toBe(row);
    expect(Object.isFrozen(input)).toBe(true);
  });

  it('allows unknown family, options, toy types and optional route codes', () => {
    const input = {
      ...withDeclarations([
        axis('relevantDimensionCodes', ['measure.dimensions.internal_width']),
        known('optionalNonpertinenceCodes', ['not.a.route']),
      ]),
      familyCode: 'future.family',
      values: [
        {
          code: 'future.definition',
          owner: 'sellable',
          variantId: 'missing',
          state: 'known',
          evidence: null,
          payload: { type: 'multi', value: ['future.option', 'future.option'] },
        },
      ],
    };
    expect(isRecognizableDocumentV2(input)).toBe(true);
  });

  it.each([
    null,
    { ...document(), extra: true },
    { ...document(), schemaVersion: 3 },
    { ...document(), facts: [{}] },
    withDeclarations([known('consumable', 'yes')]),
    withDeclarations([
      {
        ...known('consumable', true),
        evidence: { sourceRef: 1, verifiedOn: '' },
      },
    ]),
    {
      ...document(),
      values: [
        {
          code: '',
          owner: 'product',
          variantId: null,
          state: 'known',
          evidence: null,
          payload: { type: 'number', value: Infinity, unit: null },
        },
      ],
    },
  ])('returns false for real typed shape rejection %#', (input) => {
    expect(() => parseDocumentShapeV2(input)).toThrow(
      EditorialDocumentShapeError,
    );
    expect(isRecognizableDocumentV2(input)).toBe(false);
  });

  it('rejects accessors without invoking them, including nested data', () => {
    const getter = jest.fn(() => {
      throw new Error('must not execute');
    });
    const root = document();
    Object.defineProperty(root, 'familyCode', {
      enumerable: true,
      get: getter,
    });
    const nested = known('consumable', true);
    Object.defineProperty(nested, 'value', { enumerable: true, get: getter });
    expect(isRecognizableDocumentV2(root)).toBe(false);
    expect(isRecognizableDocumentV2(withDeclarations([nested]))).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    new Error('Expected a document shape V2'),
    new TypeError('Expected a document shape V2'),
    new TypeError('Expected an evidence shape V2'),
    'non-error',
    null,
  ])('rethrows unexpected reflection failures by identity %#', (sentinel) => {
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          // Deliberately exercise non-Error propagation at the public boundary.
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw sentinel;
        },
      },
    );
    for (const input of [
      proxy,
      withDeclarations([{ ...known('consumable', true), evidence: proxy }]),
    ]) {
      let thrown: unknown = Symbol('not thrown');
      try {
        isRecognizableDocumentV2(input);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(sentinel);
    }
  });

  it('propagates the same native TypeError from a revoked nested proxy', () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    let original: unknown;
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          try {
            Object.getPrototypeOf(revoked.proxy);
          } catch (error) {
            original = error;
            throw error;
          }
          return Object.prototype;
        },
      },
    );
    let thrown: unknown;
    try {
      isRecognizableDocumentV2(
        withDeclarations([{ ...known('consumable', true), evidence: proxy }]),
      );
    } catch (error) {
      thrown = error;
    }
    expect(original).toBeInstanceOf(TypeError);
    expect(thrown).toBe(original);
  });
});
