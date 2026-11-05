import { applyEditorialVocabularyLabels } from './editorial-vocabulary-labels-apply';
import {
  DEFINITION_LABELS,
  FAMILY_LABELS,
} from '../src/catalog-editorial/domain/editorial-production-vocabulary-labels';

type Row = { code?: string; unitCode?: string; label: string | null };
type Where = { code?: string; unitCode?: string; label: string };
// In-memory stand-in honouring exactly the where/data shape the script sends.
const table = (rows: Row[]) => ({
  rows,
  updateMany: jest.fn(({ where, data }: { where: Where; data: Row }) => {
    const hit = rows.filter(
      (r) =>
        (where.code === undefined || r.code === where.code) &&
        (where.unitCode === undefined || r.unitCode === where.unitCode) &&
        r.label === where.label,
    );
    hit.forEach((r) => (r.label = data.label));
    return Promise.resolve({ count: hit.length });
  }),
});
const fixture = () => ({
  editorialFamily: table([
    { code: 'food', label: 'food' },
    { code: 'treat', label: 'Golosinas de la casa' },
    { code: 'starter.general', label: 'Starter: General' },
  ]),
  editorialDefinition: table([
    { code: 'animal.target', label: 'animal.target' },
    { code: 'life.stage', label: 'Fase' },
    { code: 'starter.notes', label: 'Notes' },
  ]),
  editorialUnit: table([
    { unitCode: 'piece', label: 'piece' },
    { unitCode: 'kg', label: 'kg' },
    { unitCode: 'roll', label: 'Rollo especial' },
    { unitCode: null as unknown as string, label: null },
  ]),
});

describe('applyEditorialVocabularyLabels', () => {
  it('labels rows whose label still equals their code', async () => {
    const client = fixture();
    const result = await applyEditorialVocabularyLabels(client);
    expect(client.editorialFamily.rows[0].label).toBe(FAMILY_LABELS.food);
    expect(client.editorialDefinition.rows[0].label).toBe(
      DEFINITION_LABELS['animal.target'],
    );
    expect(client.editorialUnit.rows[0].label).toBe('Pieza');
    expect(result).toEqual({ families: 1, definitions: 1, units: 1 });
  });

  it('never overwrites customized labels, symbolic units or unknown codes', async () => {
    const client = fixture();
    await applyEditorialVocabularyLabels(client);
    expect(client.editorialFamily.rows.map((r) => r.label)).toEqual([
      'Alimento',
      'Golosinas de la casa',
      'Starter: General',
    ]);
    expect(client.editorialDefinition.rows[1].label).toBe('Fase');
    expect(client.editorialDefinition.rows[2].label).toBe('Notes');
    expect(client.editorialUnit.rows.map((r) => r.label)).toEqual([
      'Pieza',
      'kg',
      'Rollo especial',
      null,
    ]);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const client = fixture();
    await applyEditorialVocabularyLabels(client);
    const snapshot = JSON.stringify(client);
    expect(await applyEditorialVocabularyLabels(client)).toEqual({
      families: 0,
      definitions: 0,
      units: 0,
    });
    expect(JSON.stringify(client)).toBe(snapshot);
  });
});
