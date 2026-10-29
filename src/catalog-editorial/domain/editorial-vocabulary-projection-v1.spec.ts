import {
  projectVocabularyV1,
  VocabularyReadDefinition,
  VocabularyReadSnapshot,
} from './editorial-vocabulary-projection-v1';

const text = (id: string): VocabularyReadDefinition => ({
  id,
  code: id,
  label: '',
  type: 'text',
});
const binding = (
  definitionId: string,
  owner: 'PRODUCT' | 'VARIANT' = 'PRODUCT',
) => ({
  definitionId,
  definitionCode: definitionId,
  owner,
  sortOrder: -7,
});
const family = (
  id: string,
  minimumContractVersion: 1 | 2,
  ids: string[],
): VocabularyReadSnapshot['families'][number] => ({
  id,
  code: id,
  label: '',
  minimumContractVersion,
  bindings: ids.map((id) => binding(id)),
});
const resolved = {
  status: 'resolved' as const,
  magnitude: 'historical magnitude',
  integer: false,
  lower: null,
  lowerInclusive: false,
  upper: null,
  upperInclusive: true,
};
const numeric = (
  id: string,
  extra: Partial<
    Extract<VocabularyReadDefinition, { type: 'number' | 'range' }>
  > = {},
): VocabularyReadDefinition => ({
  id,
  code: id,
  label: '',
  type: 'number',
  units: [],
  ...extra,
});

function freezeTree(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeTree);
    Object.freeze(value);
  }
}

function expectDetached(input: unknown, output: unknown): void {
  const originals = new Set<object>();
  const collect = (value: unknown) => {
    if (value && typeof value === 'object') {
      originals.add(value);
      Object.values(value).forEach(collect);
    }
  };
  const check = (value: unknown) => {
    if (value && typeof value === 'object') {
      expect(originals.has(value)).toBe(false);
      Object.values(value).forEach(check);
    }
  };
  collect(input);
  check(output);
}

describe('projectVocabularyV1 (T3c S2/S18/S19)', () => {
  it('keeps an empty snapshot and an empty legacy family', () => {
    expect(projectVocabularyV1({ families: [], definitions: [] })).toEqual({
      families: [],
      definitions: [],
    });
    expect(
      projectVocabularyV1({
        families: [family('empty', 1, [])],
        definitions: [],
      }),
    ).toEqual({
      families: [{ id: 'empty', code: 'empty', label: '', bindings: [] }],
      definitions: [],
    });
  });

  it('retains or removes whole families, all bindings, and shared definitions once', () => {
    const kept = family('z', 1, ['shared', 'b']);
    const snapshot = {
      families: [
        family('advanced', 2, ['shared', 'orphan']),
        kept,
        family('a', 1, ['shared']),
      ],
      definitions: [text('orphan'), text('b'), text('shared')],
    };
    const output = projectVocabularyV1(snapshot);
    expect(output.families).toEqual(
      [kept, snapshot.families[2]].map(({ id, code, label, bindings }) => ({
        id,
        code,
        label,
        bindings,
      })),
    );
    expect(output.definitions).toEqual([text('b'), text('shared')]);
  });

  it('omits an entirely advanced snapshot', () => {
    const snapshot = {
      families: [family('advanced', 2, ['n', 'r'])],
      definitions: [
        numeric('n', { numericPolicy: resolved }),
        numeric('r', { type: 'range' }),
      ],
    };
    expect(projectVocabularyV1(snapshot)).toEqual({
      families: [],
      definitions: [],
    });
  });

  it('does not reinterpret omitted-family-only text as originally unbound', () => {
    expect(
      projectVocabularyV1({
        families: [family('advanced', 2, ['orphan'])],
        definitions: [text('orphan'), text('unbound')],
      }),
    ).toEqual({ families: [], definitions: [text('unbound')] });
  });

  it.each([
    ['missing', numeric('n'), true],
    ['null', numeric('n', { numericPolicy: null }), true],
    ['pending', numeric('n', { numericPolicy: { status: 'pending' } }), true],
    ['resolved', numeric('n', { numericPolicy: resolved }), false],
    ['range', numeric('n', { type: 'range' }), false],
  ])(
    'classifies originally unbound %s numeric metadata',
    (_name, definition, kept) => {
      expect(
        projectVocabularyV1({ families: [], definitions: [definition] })
          .definitions,
      ).toEqual(
        kept
          ? [{ id: 'n', code: 'n', label: '', type: 'number', units: [] }]
          : [],
      );
    },
  );

  it('copies only V1 fields across all five branches without historical normalization', () => {
    const units = [
      { code: 'z', label: null, sortOrder: 8 },
      { code: null, label: 'independent', sortOrder: -2 },
      { code: null, label: null, sortOrder: -2 },
      { code: 'a', label: '', sortOrder: 8 },
    ];
    const options = [
      { code: 'z', label: '', archived: true, sortOrder: 9 },
      { code: 'a', label: '  historical  ', archived: false, sortOrder: -9 },
    ];
    const definitions = [
      { ...text('t'), groups: [], aliases: [] },
      { ...numeric('n'), units, numericPolicy: null },
      { id: 'b', code: 'b', label: ' ', type: 'boolean' as const },
      {
        id: 's',
        code: 's',
        label: '',
        type: 'single' as const,
        options,
        groups: [],
      },
      { id: 'm', code: 'm', label: '', type: 'multi' as const, options: [] },
    ];
    const snapshot = {
      families: [
        {
          ...family('legacy', 1, []),
          exposure: 'INTERNAL',
          bindings: [
            { ...binding('s', 'VARIANT'), policy: null, searchable: false },
            ...['n', 'b', 't', 'm'].map((id) => binding(id)),
          ],
        },
      ],
      definitions,
      semanticsVersion: 'editorial-production-1',
    };
    const before = JSON.stringify(snapshot);
    freezeTree(snapshot);
    const output = projectVocabularyV1(snapshot);
    expect(output).toEqual({
      families: [
        {
          id: 'legacy',
          code: 'legacy',
          label: '',
          bindings: [
            binding('s', 'VARIANT'),
            ...['n', 'b', 't', 'm'].map((id) => binding(id)),
          ],
        },
      ],
      definitions: [
        text('t'),
        { id: 'n', code: 'n', label: '', type: 'number', units },
        { id: 'b', code: 'b', label: ' ', type: 'boolean' },
        { id: 's', code: 's', label: '', type: 'single', options },
        { id: 'm', code: 'm', label: '', type: 'multi', options: [] },
      ],
    });
    expectDetached(snapshot, output);
    expect(JSON.stringify(snapshot)).toBe(before);
    output.families[0].bindings[0].sortOrder = 99;
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('rejects a retained range contradiction instead of silently pruning its binding', () => {
    const snapshot = {
      families: [family('contradictory', 1, ['range'])],
      definitions: [numeric('range', { type: 'range' })],
    };
    freezeTree(snapshot);
    expect(() => projectVocabularyV1(snapshot)).toThrow(
      'V1 projection precondition: retained range',
    );
  });
});
