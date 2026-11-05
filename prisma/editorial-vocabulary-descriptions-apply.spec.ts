import { applyEditorialVocabularyDescriptions } from './editorial-vocabulary-descriptions-apply';
import { DEFINITION_DESCRIPTIONS } from '../src/catalog-editorial/domain/editorial-production-vocabulary-descriptions';

type Row = { code: string; description: string | null };
type Where = { code: string; description: null };
// In-memory stand-in honouring exactly the where/data shape the script sends.
const table = (rows: Row[]) => ({
  rows,
  updateMany: jest.fn(
    ({ where, data }: { where: Where; data: { description: string } }) => {
      const hit = rows.filter(
        (r) => r.code === where.code && r.description === where.description,
      );
      hit.forEach((r) => (r.description = data.description));
      return Promise.resolve({ count: hit.length });
    },
  ),
});
const fixture = () => ({
  editorialDefinition: table([
    { code: 'animal.target', description: null },
    { code: 'life.stage', description: 'Texto propio del usuario.' },
    { code: 'text.clinical_analysis', description: null },
    { code: 'starter.notes', description: null },
  ]),
});

describe('applyEditorialVocabularyDescriptions', () => {
  it('describes definitions whose description is still NULL', async () => {
    const client = fixture();
    const result = await applyEditorialVocabularyDescriptions(client);
    const rows = client.editorialDefinition.rows;
    expect(rows[0].description).toBe(DEFINITION_DESCRIPTIONS['animal.target']);
    expect(rows[2].description).toBe(
      DEFINITION_DESCRIPTIONS['text.clinical_analysis'],
    );
    expect(result).toEqual({ definitions: 2 });
  });

  it('never overwrites a customized description and never touches unknown codes', async () => {
    const client = fixture();
    await applyEditorialVocabularyDescriptions(client);
    const rows = client.editorialDefinition.rows;
    expect(rows[1].description).toBe('Texto propio del usuario.');
    // Starter rows are outside the production map and stay NULL.
    expect(rows[3].description).toBeNull();
  });

  it('only ever sends a NULL-guarded update by code, writing nothing else', async () => {
    const client = fixture();
    await applyEditorialVocabularyDescriptions(client);
    const calls = client.editorialDefinition.updateMany.mock.calls;
    expect(calls).toHaveLength(Object.keys(DEFINITION_DESCRIPTIONS).length);
    for (const [{ where, data }] of calls) {
      expect(Object.keys(where).sort()).toEqual(['code', 'description']);
      expect(where.description).toBeNull();
      expect(Object.keys(data)).toEqual(['description']);
      expect(data.description).toBe(
        DEFINITION_DESCRIPTIONS[
          where.code as keyof typeof DEFINITION_DESCRIPTIONS
        ],
      );
    }
  });

  it('is idempotent: a second run changes nothing', async () => {
    const client = fixture();
    await applyEditorialVocabularyDescriptions(client);
    const snapshot = JSON.stringify(client.editorialDefinition.rows);
    expect(await applyEditorialVocabularyDescriptions(client)).toEqual({
      definitions: 0,
    });
    expect(JSON.stringify(client.editorialDefinition.rows)).toBe(snapshot);
  });
});
