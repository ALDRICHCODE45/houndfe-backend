import { withFamilySections } from './editorial-vocabulary-sections';

const binding = (definitionCode: string, sortOrder: number) => ({
  definitionId: `id-${definitionCode}`,
  definitionCode,
  owner: 'sellable' as const,
  sortOrder,
});
const body = () => ({
  contractVersion: 2 as const,
  vocabularyRevision: `ev2-sha256-${'a'.repeat(64)}`,
  vocabulary: {
    semanticsVersion: 'editorial-production-1',
    families: [
      {
        id: 'f1',
        code: 'food',
        label: 'Alimento',
        bindings: [
          binding('animal.target', 0),
          binding('text.instructions', 1),
          binding('food.format', 2),
          binding('life.stage', 3),
        ],
      },
      {
        id: 'f2',
        code: 'starter.general',
        label: 'General',
        bindings: [binding('starter.notes', 0)],
      },
    ],
    definitions: [{ id: 'id-animal.target', code: 'animal.target' }],
  },
});
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

describe('withFamilySections', () => {
  it('adds the present sections in order and positions each binding inside its section', () => {
    const [food] = withFamilySections(body()).vocabulary.families;
    expect(food.sections).toEqual([
      { code: 'para-quien', label: 'Para quién', sortOrder: 0 },
      { code: 'que-es', label: 'Qué es', sortOrder: 1 },
      { code: 'uso', label: 'Uso', sortOrder: 4 },
    ]);
    expect(food.bindings).toEqual([
      {
        ...binding('animal.target', 0),
        sectionCode: 'para-quien',
        sectionSortOrder: 0,
      },
      {
        ...binding('text.instructions', 1),
        sectionCode: 'uso',
        sectionSortOrder: 0,
      },
      {
        ...binding('food.format', 2),
        sectionCode: 'que-es',
        sectionSortOrder: 0,
      },
      {
        ...binding('life.stage', 3),
        sectionCode: 'para-quien',
        sectionSortOrder: 1,
      },
    ]);
  });

  it('omits the keys (never null) for non-production families and unsectioned bindings', () => {
    const input = body();
    input.vocabulary.families[0].bindings.push(binding('starter.notes', 9));
    const [food, starter] = withFamilySections(input).vocabulary.families;
    expect(starter).toBe(input.vocabulary.families[1]);
    expect(starter).not.toHaveProperty('sections');
    expect(food.bindings[4]).toEqual(binding('starter.notes', 9));
    expect(food.bindings[4]).not.toHaveProperty('sectionCode');
    expect(food.bindings[4]).not.toHaveProperty('sectionSortOrder');
  });

  it('never touches the revision, definitions or anything outside families', () => {
    const input = body();
    const result = withFamilySections(input);
    expect(result.vocabularyRevision).toBe(input.vocabularyRevision);
    expect(result.contractVersion).toBe(2);
    expect(result.vocabulary.definitions).toBe(input.vocabulary.definitions);
    expect(result.vocabulary.semanticsVersion).toBe('editorial-production-1');
  });

  it('does not mutate its input, even when frozen', () => {
    const input = freeze(body());
    const before = JSON.stringify(input);
    withFamilySections(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('returns the very same body when no family has a section', () => {
    const input = body();
    input.vocabulary.families = [input.vocabulary.families[1]];
    expect(withFamilySections(input)).toBe(input);
    const empty = body();
    empty.vocabulary.families[0].bindings = [binding('starter.notes', 0)];
    empty.vocabulary.families = [empty.vocabulary.families[0]];
    expect(withFamilySections(empty)).toBe(empty);
  });
});
