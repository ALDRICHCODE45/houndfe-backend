import {
  parseSellableFactsShapeV2 as parse,
  type SellableFactsShapeV2,
} from './editorial-sellable-facts-shape-v2';

const evidence = () => ({ sourceRef: '\ud800', verifiedOn: 'not-a-date' });
const declaration = () => ({
  key: 'relevantDimensionCodes',
  state: 'known',
  value: { codes: ['future', 'future'], toyTypes: ['', '\ud800'] },
  evidence: evidence(),
  basis: '',
});
const care = () => ({
  state: 'prepared',
  jurisdiction: '',
  intendedUse: '\ud800',
  determination: 'none_applicable',
  evidence: [evidence()],
  basis: '',
  requirements: [
    {
      key: '',
      description: '',
      disposition: 'conflicting',
      evidence: [evidence()],
      basis: '',
    },
  ],
  warnings: [
    {
      key: '',
      requirementKeys: ['unknown', 'unknown'],
      text: '',
      disclosure: 'public_required',
      evidence: [evidence()],
      handlingBasis: '',
    },
  ],
});
const row = () => ({
  variantId: null,
  presentation: '',
  declarations: [],
  careReview: null,
});
const message = 'Expected a sellable facts shape V2';
function rejects(input: unknown, expected = message) {
  expect(() => parse(input)).toThrow(new TypeError(expected));
}
function detached(source: unknown, output: unknown) {
  expect(output).toEqual(source);
  if (!source || typeof source !== 'object') return;
  expect(output).not.toBe(source);
  for (const key of Object.keys(source)) {
    detached(
      (source as Record<string, unknown>)[key],
      (output as Record<string, unknown>)[key],
    );
  }
}
function freeze(input: unknown) {
  if (!input || typeof input !== 'object') return;
  Object.values(input).forEach(freeze);
  Object.freeze(input);
}

describe('parseSellableFactsShapeV2', () => {
  it.each([null, '', 'unknown-variant', '\ud800'])(
    'preserves variant %p and null care',
    (variantId) => {
      const input = { ...row(), variantId };
      const result: SellableFactsShapeV2 = parse(input);
      expect(result).toEqual(input);
      expect(result).not.toBe(input);
      expect(result.declarations).not.toBe(input.declarations);
      expect(result.careReview).toBeNull();
    },
  );

  it('preserves unknown care, empty, duplicate and ordered declarations', () => {
    const first = declaration();
    const second = { key: 'consumable', state: 'unknown', evidence: null };
    const input = {
      ...row(),
      declarations: [first, second, first],
      careReview: { state: 'unknown' },
    };
    detached(input, parse(input));
  });

  it('detaches every frozen prepared-care/declaration object and array', () => {
    const input = {
      ...row(),
      presentation: '\ud800',
      declarations: [declaration()],
      careReview: care(),
    };
    freeze(input);
    const output = parse(input);
    detached(input, output);
    const known = output.declarations[0];
    if (known.key !== 'relevantDimensionCodes' || known.state !== 'known')
      throw new Error('Unexpected declaration fixture');
    known.value.codes.push('changed');
    known.evidence.sourceRef = 'changed';
    if (output.careReview?.state !== 'prepared')
      throw new Error('Unexpected care fixture');
    output.careReview.warnings[0].requirementKeys.push('changed');
    output.careReview.requirements[0].evidence[0].verifiedOn = 'changed';
    expect(input.declarations[0].value.codes).toEqual(['future', 'future']);
    expect(input.declarations[0].evidence.sourceRef).toBe('\ud800');
    expect(input.careReview).toEqual(care());
  });

  it('accepts null-prototype records through the composed leaves', () => {
    const input = Object.assign(Object.create(null) as object, {
      ...row(),
      declarations: [
        Object.assign(Object.create(null) as object, declaration()),
      ],
      careReview: Object.assign(Object.create(null) as object, {
        state: 'unknown',
      }),
    });
    expect(parse(input)).toEqual(input);
  });

  it.each(Object.keys(row()))('requires %s', (key) => {
    const { [key]: omitted, ...input } = row() as Record<string, unknown>;
    void omitted;
    rejects(input);
  });
  it.each([
    null,
    undefined,
    true,
    'row',
    [],
    new Date(),
    { ...row(), extra: null },
    { ...row(), variantId: 1 },
    { ...row(), variantId: undefined },
    { ...row(), presentation: null },
    { ...row(), declarations: 'declarations' },
    { ...row(), declarations: {} },
    Object.assign(Object.create({ inherited: true }) as object, row()),
  ])('rejects malformed parent %p', (input) => rejects(input));

  it.each([
    [{ ...row(), declarations: [null] }, 'Expected a declaration shape V2'],
    [{ ...row(), careReview: false }, 'Expected a care capture shape V2'],
    [
      { ...row(), declarations: [{ ...declaration(), evidence: null }] },
      'Expected a declaration shape V2',
    ],
    [
      {
        ...row(),
        declarations: [
          { ...declaration(), evidence: { sourceRef: 1, verifiedOn: '' } },
        ],
      },
      'Expected an evidence shape V2',
    ],
    [
      { ...row(), careReview: { ...care(), evidence: [null] } },
      'Expected an evidence shape V2',
    ],
  ])('preserves leaf rejection for %p', (input, expected) =>
    rejects(input, expected),
  );

  it.each(['root', 'index', 'declaration', 'care', 'evidence'])(
    'never executes %s getters',
    (level) => {
      const getter = jest.fn(() => {
        throw new Error('Getter executed');
      });
      const input = {
        ...row(),
        declarations: [declaration()],
        careReview: care(),
      };
      const [target, key] =
        level === 'root'
          ? [input, 'presentation']
          : level === 'index'
            ? [input.declarations, '0']
            : level === 'declaration'
              ? [input.declarations[0].value, 'codes']
              : level === 'care'
                ? [input.careReview, 'jurisdiction']
                : [input.careReview.evidence[0], 'sourceRef'];
      Object.defineProperty(target, key, { enumerable: true, get: getter });
      expect(() => parse(input)).toThrow(TypeError);
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it.each(['hidden', 'symbol', 'hidden-required'])(
    'rejects %s root properties',
    (kind) => {
      const input = row();
      Object.defineProperty(
        input,
        kind === 'symbol'
          ? Symbol('extra')
          : kind === 'hidden-required'
            ? 'presentation'
            : 'extra',
        { value: '', enumerable: false },
      );
      rejects(input);
    },
  );

  it.each(['sparse', 'extra', 'hidden', 'symbol', 'hidden-index', 'prototype'])(
    'rejects %s declarations arrays',
    (kind) => {
      const declarations = [declaration()];
      if (kind === 'sparse') declarations.length = 2;
      else if (kind === 'prototype') Object.setPrototypeOf(declarations, null);
      else
        Object.defineProperty(
          declarations,
          kind === 'symbol'
            ? Symbol('extra')
            : kind === 'hidden-index'
              ? '0'
              : 'extra',
          { value: declaration(), enumerable: kind === 'extra' },
        );
      rejects({ ...row(), declarations });
    },
  );

  describe.each(['root', 'array', 'declaration', 'care'])(
    '%s reflection failure identity',
    (level) => {
      it.each([new Error('reflection'), new TypeError(message), 'non-error'])(
        'propagates %p unchanged',
        (sentinel) => {
          const target =
            level === 'root'
              ? row()
              : level === 'array'
                ? []
                : level === 'declaration'
                  ? declaration()
                  : care();
          const proxy = new Proxy(target, {
            ownKeys() {
              // Deliberately exercise propagation of non-Error reflection failures.
              // eslint-disable-next-line @typescript-eslint/only-throw-error
              throw sentinel;
            },
          });
          const input =
            level === 'root'
              ? proxy
              : level === 'array'
                ? { ...row(), declarations: proxy }
                : level === 'declaration'
                  ? { ...row(), declarations: [proxy] }
                  : { ...row(), careReview: proxy };
          let caught: unknown;
          try {
            parse(input);
          } catch (error) {
            caught = error;
          }
          expect(caught).toBe(sentinel);
        },
      );
    },
  );
});
