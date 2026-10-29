import {
  parseDocumentShapeV2 as parse,
  type DocumentShapeV2,
} from './editorial-document-shape-v2';

const document = () => ({
  schemaVersion: 2,
  commercialTitle: null,
  description: null,
  mediaRefs: [],
  familyCode: null,
  values: [],
  facts: [],
});
const evidence = () => ({ sourceRef: '\ud800', verifiedOn: 'not-a-date' });
const value = () => ({
  code: 'future',
  owner: 'product',
  variantId: 'unknown',
  state: 'known',
  payload: { type: 'multi', value: ['future', '', 'future'] },
  evidence: evidence(),
});
const facts = () => ({
  variantId: 'unknown',
  presentation: '',
  declarations: [
    {
      key: 'relevantDimensionCodes',
      state: 'known',
      value: { codes: ['future', 'future'], toyTypes: ['\ud800'] },
      evidence: evidence(),
      basis: '',
    },
  ],
  careReview: {
    state: 'prepared',
    jurisdiction: '',
    intendedUse: '',
    determination: 'none_applicable',
    evidence: [evidence()],
    basis: '',
    requirements: [],
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
  },
});
const message = 'Expected a document shape V2';
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

describe('parseDocumentShapeV2', () => {
  it('returns the empty seven-key V2 document without inferred fields', () => {
    const input = document();
    const output: DocumentShapeV2 = parse(input);
    detached(input, output);
    expect(Object.keys(output)).toEqual(Object.keys(input));
  });

  it('preserves order, duplicates, historical strings and relational conflicts', () => {
    const first = value();
    const row = facts();
    const input = {
      ...document(),
      commercialTitle: '',
      description: '\ud800',
      mediaRefs: ['z', 'a', 'z', '\ud800'],
      values: [
        first,
        { ...first, payload: { type: 'range', min: 9, max: -1, unit: '' } },
        first,
      ],
      facts: [row, { ...row, variantId: 'second' }, row],
    };
    freeze(input);
    const output = parse(input);
    detached(input, output);
    expect(output.familyCode).toBeNull();
    output.mediaRefs.push('changed');
    const known = output.values[0];
    if (known.state !== 'known' || known.payload.type !== 'multi')
      throw new Error('Unexpected value fixture');
    known.payload.value.push('changed');
    if (known.evidence) known.evidence.sourceRef = 'changed';
    const declaration = output.facts[0].declarations[0];
    if (
      declaration.key !== 'relevantDimensionCodes' ||
      declaration.state !== 'known'
    )
      throw new Error('Unexpected declaration fixture');
    declaration.value.codes.push('changed');
    const care = output.facts[0].careReview;
    if (care?.state !== 'prepared') throw new Error('Unexpected care fixture');
    care.warnings[0].requirementKeys.push('changed');
    care.evidence[0].verifiedOn = 'changed';
    expect(input.mediaRefs).toHaveLength(4);
    expect(input.values[0]).toEqual(value());
    expect(input.facts[0]).toEqual(facts());
    expect(output.values[2]).toEqual(value());
    expect(output.facts[2]).toEqual(facts());
  });

  it('accepts null-prototype root and nested records', () => {
    const nullRecord = (input: object) =>
      Object.assign(Object.create(null) as object, input);
    const input = nullRecord({
      ...document(),
      familyCode: '',
      values: [nullRecord(value())],
      facts: [nullRecord(facts())],
    });
    detached(input, parse(input));
  });

  it.each(['values', 'facts'])('rejects decorated/exotic %s records', (key) => {
    for (const extra of ['extra', Symbol('extra'), null]) {
      const item = key === 'values' ? value() : facts();
      if (extra === null) Object.setPrototypeOf(item, { inherited: true });
      else Object.defineProperty(item, extra, { value: null });
      const leaf = key === 'values' ? 'value' : 'sellable facts';
      rejects({ ...document(), [key]: [item] }, `Expected a ${leaf} shape V2`);
    }
  });

  it.each(Object.keys(document()))('requires %s', (key) => {
    const { [key]: omitted, ...input } = document() as Record<string, unknown>;
    void omitted;
    rejects(input);
  });
  it.each([
    null,
    undefined,
    true,
    'document',
    [],
    new Date(),
    {},
    {
      commercialTitle: null,
      description: null,
      mediaRefs: [],
      familyCode: null,
      values: [],
    },
    { ...document(), extra: null },
    ...[null, undefined, '2', 1, 3].map((schemaVersion) => ({
      ...document(),
      schemaVersion,
    })),
    ...['commercialTitle', 'description', 'familyCode'].flatMap((key) =>
      [undefined, false, 1, {}].map((item) => ({ ...document(), [key]: item })),
    ),
    ...['mediaRefs', 'values', 'facts'].flatMap((key) =>
      [undefined, null, 'array', {}].map((item) => ({
        ...document(),
        [key]: item,
      })),
    ),
    { ...document(), mediaRefs: [1] },
    Object.assign(Object.create({ inherited: true }) as object, document()),
  ])('rejects malformed parent %p', (input) => rejects(input));

  it.each([
    [{ ...document(), values: [null] }, 'Expected a value shape V2'],
    [{ ...document(), facts: [null] }, 'Expected a sellable facts shape V2'],
    [
      {
        ...document(),
        values: [
          {
            ...value(),
            payload: { type: 'number', value: Infinity, unit: null },
          },
        ],
      },
      'Expected a known payload shape V2',
    ],
    [
      { ...document(), values: [{ ...value(), evidence: {} }] },
      'Expected an evidence shape V2',
    ],
    [
      { ...document(), facts: [{ ...facts(), declarations: [null] }] },
      'Expected a declaration shape V2',
    ],
    [
      { ...document(), facts: [{ ...facts(), careReview: {} }] },
      'Expected a care capture shape V2',
    ],
  ])('preserves nested rejection for %p', (input, expected) =>
    rejects(input, expected),
  );

  it.each(['root', 'array', 'value', 'payload', 'facts', 'care'])(
    'does not execute %s getters',
    (level) => {
      const getter = jest.fn(() => {
        throw new Error('Getter executed');
      });
      const input = { ...document(), values: [value()], facts: [facts()] };
      const targets: Record<string, [object, string]> = {
        root: [input, 'schemaVersion'],
        array: [input.values, '0'],
        value: [input.values[0], 'code'],
        payload: [input.values[0].payload, 'value'],
        facts: [input.facts[0], 'presentation'],
        care: [input.facts[0].careReview, 'state'],
      };
      const [target, key] = targets[level];
      Object.defineProperty(target, key, { enumerable: true, get: getter });
      expect(() => parse(input)).toThrow(TypeError);
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it.each(['hidden', 'symbol', 'hidden-required'])(
    'rejects %s root data',
    (kind) => {
      const input = document();
      Object.defineProperty(
        input,
        kind === 'symbol'
          ? Symbol('extra')
          : kind === 'hidden-required'
            ? 'schemaVersion'
            : 'extra',
        { value: 2, enumerable: false },
      );
      rejects(input);
    },
  );

  describe.each(['mediaRefs', 'values', 'facts'])('%s array safety', (key) => {
    it.each([
      'sparse',
      'extra',
      'hidden',
      'symbol',
      'hidden-index',
      'prototype',
      'accessor',
    ])('rejects %s without executing getters', (kind) => {
      const items: unknown[] = [
        key === 'mediaRefs' ? '' : key === 'values' ? value() : facts(),
      ];
      const getter = jest.fn(() => 'never');
      if (kind === 'sparse') items.length = 2;
      else if (kind === 'prototype') Object.setPrototypeOf(items, null);
      else
        Object.defineProperty(
          items,
          kind === 'symbol'
            ? Symbol('extra')
            : kind === 'hidden-index' || kind === 'accessor'
              ? '0'
              : 'extra',
          kind === 'accessor'
            ? { enumerable: true, get: getter }
            : { value: '', enumerable: kind === 'extra' },
        );
      rejects({ ...document(), [key]: items });
      expect(getter).not.toHaveBeenCalled();
    });
  });

  describe.each(['root', 'mediaRefs', 'values', 'facts', 'value', 'row'])(
    '%s reflection failures',
    (level) => {
      it.each([new Error('reflection'), new TypeError(message), 'non-error'])(
        'propagates %p by identity',
        (sentinel) => {
          const target =
            level === 'root'
              ? document()
              : level === 'value'
                ? value()
                : level === 'row'
                  ? facts()
                  : [];
          const proxy = new Proxy(target, {
            ownKeys() {
              // Reflection failures, including non-Errors, are not admission errors.
              // eslint-disable-next-line @typescript-eslint/only-throw-error
              throw sentinel;
            },
          });
          const input =
            level === 'root'
              ? proxy
              : level === 'value'
                ? { ...document(), values: [proxy] }
                : level === 'row'
                  ? { ...document(), facts: [proxy] }
                  : { ...document(), [level]: proxy };
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
