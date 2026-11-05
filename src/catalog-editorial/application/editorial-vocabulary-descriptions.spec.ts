import { withDefinitionDescriptions } from './editorial-vocabulary-descriptions';

const body = () => ({
  contractVersion: 2 as const,
  vocabularyRevision: `ev2-sha256-${'a'.repeat(64)}`,
  vocabulary: {
    semanticsVersion: 'editorial-production-1',
    families: [{ code: 'food' }],
    definitions: [
      { id: '1', code: 'animal.target', label: 'Especie', type: 'multi' },
      { id: '2', code: 'life.stage', label: 'Etapa de vida', type: 'multi' },
      { id: '3', code: 'starter.notes', label: 'Notas', type: 'text' },
    ],
  },
});
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

describe('withDefinitionDescriptions', () => {
  it('adds description only to definitions that have one, and omits it otherwise', () => {
    const result = withDefinitionDescriptions(
      body(),
      new Map([['animal.target', 'Para qué animales es.']]),
    );
    expect(result.vocabulary.definitions).toEqual([
      {
        id: '1',
        code: 'animal.target',
        label: 'Especie',
        type: 'multi',
        description: 'Para qué animales es.',
      },
      { id: '2', code: 'life.stage', label: 'Etapa de vida', type: 'multi' },
      { id: '3', code: 'starter.notes', label: 'Notas', type: 'text' },
    ]);
    // Omitted, not null: the key itself must be absent.
    expect(result.vocabulary.definitions[1]).not.toHaveProperty('description');
    expect(result.vocabulary.definitions[2]).not.toHaveProperty('description');
  });

  it('never touches the revision, contract version or anything outside definitions', () => {
    const input = body();
    const result = withDefinitionDescriptions(
      input,
      new Map([['animal.target', 'Texto.']]),
    );
    expect(result.vocabularyRevision).toBe(input.vocabularyRevision);
    expect(result.contractVersion).toBe(2);
    expect(result.vocabulary.semanticsVersion).toBe('editorial-production-1');
    expect(result.vocabulary.families).toBe(input.vocabulary.families);
  });

  it('does not mutate its input, even when frozen', () => {
    const input = freeze(body());
    const before = JSON.stringify(input);
    withDefinitionDescriptions(input, new Map([['animal.target', 'Texto.']]));
    expect(JSON.stringify(input)).toBe(before);
  });

  it('returns the very same body when there is nothing to attach', () => {
    const input = body();
    expect(withDefinitionDescriptions(input, new Map())).toBe(input);
    expect(
      withDefinitionDescriptions(input, new Map([['unknown.code', 'Texto.']])),
    ).toBe(input);
  });

  it.each(['', '   ', '\n'])(
    'ignores blank descriptions (%j) instead of serving empty help',
    (blank) => {
      const input = body();
      const result = withDefinitionDescriptions(
        input,
        new Map([['animal.target', blank]]),
      );
      expect(result).toBe(input);
    },
  );
});
