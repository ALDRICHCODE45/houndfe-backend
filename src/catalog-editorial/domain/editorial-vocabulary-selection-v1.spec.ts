import { indexVocabularyV1Bindings } from './editorial-vocabulary-selection-v1';
import {
  projectVocabularyV1,
  VocabularyReadDefinition,
  VocabularyReadSnapshot,
} from './editorial-vocabulary-projection-v1';

const family = (minimumContractVersion: 1 | 2, ids: readonly string[]) => ({
  minimumContractVersion,
  bindings: ids.map((definitionId) => ({ definitionId })),
});

describe('indexVocabularyV1Bindings (T3c S2/S18)', () => {
  it.each([{ families: [] }, { families: [family(1, []), family(2, [])] }])(
    'returns empty membership for empty families/bindings: %j',
    ({ families }) => {
      expect(indexVocabularyV1Bindings(families)).toEqual({
        originallyBound: new Set(),
        retained: new Set(),
      });
    },
  );

  it.each([1, 2] as const)('indexes an all-V%s graph', (version) => {
    expect(
      indexVocabularyV1Bindings([
        family(version, ['z', 'shared']),
        family(version, ['shared', 'a']),
      ]),
    ).toEqual({
      originallyBound: new Set(['z', 'shared', 'a']),
      retained: new Set(version === 1 ? ['z', 'shared', 'a'] : []),
    });
  });

  it('records omitted-only and shared membership before family filtering', () => {
    expect(
      indexVocabularyV1Bindings([
        family(2, ['omitted-only', 'shared']),
        family(1, ['shared', 'kept']),
      ]),
    ).toEqual({
      originallyBound: new Set(['omitted-only', 'shared', 'kept']),
      retained: new Set(['shared', 'kept']),
    });
  });

  it('preserves exact blank and whitespace IDs without normalization', () => {
    expect(
      indexVocabularyV1Bindings([family(2, ['']), family(1, [' ', '  '])]),
    ).toEqual({
      originallyBound: new Set(['', ' ', '  ']),
      retained: new Set([' ', '  ']),
    });
  });

  it('does not mutate a deeply frozen graph', () => {
    const families = Object.freeze(
      [family(2, ['orphan']), family(1, ['kept'])].map((entry) =>
        Object.freeze({
          ...entry,
          bindings: Object.freeze(
            entry.bindings.map((binding) => Object.freeze(binding)),
          ),
        }),
      ),
    );
    const before = JSON.stringify(families);
    expect(indexVocabularyV1Bindings(families).retained.has('kept')).toBe(true);
    expect(JSON.stringify(families)).toBe(before);
  });

  it('has identical membership under family and binding order permutations', () => {
    const graph = [
      family(2, ['only-v2', 'shared']),
      family(1, ['z', 'shared']),
    ];
    const expected = indexVocabularyV1Bindings(graph);
    for (const families of [graph, [...graph].reverse()]) {
      expect(
        indexVocabularyV1Bindings(
          families.map((entry) => ({
            ...entry,
            bindings: [...entry.bindings].reverse(),
          })),
        ),
      ).toEqual(expected);
    }
  });

  it('owns distinct fresh sets detached from input and later calls', () => {
    const graph = [family(1, ['kept']), family(2, ['omitted'])];
    const first = indexVocabularyV1Bindings(graph);
    const second = indexVocabularyV1Bindings(graph);
    expect(first.originallyBound).not.toBe(first.retained);
    expect(first.originallyBound).not.toBe(second.originallyBound);
    expect(first.retained).not.toBe(second.retained);
    graph[0].bindings[0].definitionId = 'changed';
    graph[1].bindings.push({ definitionId: 'later' });
    expect(first).toEqual({
      originallyBound: new Set(['kept', 'omitted']),
      retained: new Set(['kept']),
    });
    expect(second).toEqual(first);
    expect(indexVocabularyV1Bindings(graph)).toEqual({
      originallyBound: new Set(['changed', 'omitted', 'later']),
      retained: new Set(['changed']),
    });
  });
});

describe('public V1 projector selection regression', () => {
  it('preserves orphan exclusion, shared order and absent-policy unbound numbers', () => {
    const text = (id: string): VocabularyReadDefinition => ({
      id,
      code: id,
      label: '',
      type: 'text',
    });
    const number = (id: string): VocabularyReadDefinition => ({
      id,
      code: id,
      label: '',
      type: 'number',
      units: [],
    });
    const families: VocabularyReadSnapshot['families'] = [
      family(2, ['orphan', 'shared']),
      family(1, ['shared']),
      family(1, []),
    ].map((entry, index) => ({
      ...entry,
      id: String(index),
      code: String(index),
      label: '',
      bindings: entry.bindings.map((binding) => ({
        ...binding,
        definitionCode: binding.definitionId,
        owner: 'product',
        sortOrder: -1,
      })),
    }));
    const snapshot: VocabularyReadSnapshot = {
      families,
      definitions: [
        text('orphan'),
        number('unbound-absent'),
        text('shared'),
        {
          ...number('unbound-resolved'),
          type: 'number',
          units: [],
          numericPolicy: {
            status: 'resolved',
            magnitude: 'historical',
            integer: false,
            lower: null,
            lowerInclusive: false,
            upper: null,
            upperInclusive: false,
          },
        },
      ],
    };
    expect(projectVocabularyV1(snapshot)).toEqual({
      families: families.slice(1).map(({ id, code, label, bindings }) => ({
        id,
        code,
        label,
        bindings,
      })),
      definitions: [number('unbound-absent'), text('shared')],
    });
  });
});
