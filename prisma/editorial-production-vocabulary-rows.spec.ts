import { buildProductionVocabularyManifest } from './editorial-production-vocabulary.manifest';
import {
  productionVocabularyRows,
  VocabularyStorageIdentities,
} from './editorial-production-vocabulary-rows';
import { materializeStoredVocabularyV2 } from '../src/catalog-editorial/domain/editorial-vocabulary-stored-root-v2';
import { validateFullProductionVocabularyV2 } from '../src/catalog-editorial/domain/editorial-vocabulary-full-production-v2';

const manifest = buildProductionVocabularyManifest();
function identities(): VocabularyStorageIdentities {
  return {
    families: Object.fromEntries(
      manifest.families.map((f, i) => [f.code, `family-${i}`]),
    ),
    definitions: Object.fromEntries(
      manifest.definitions.map((d, i) => [
        d.code,
        { id: `definition-${i}`, type: d.type },
      ]),
    ),
    units: Object.fromEntries(
      manifest.definitions.flatMap((d) =>
        'units' in d
          ? d.units.map((u) => [
              JSON.stringify([d.code, u.code]),
              `unit-${d.code}-${u.code}`,
            ])
          : [],
      ),
    ),
  };
}

describe('canonical production storage rows', () => {
  it('round-trips every canonical field and all 68 definition codes', () => {
    const ids = identities();
    const before = structuredClone(ids);
    const rows = productionVocabularyRows(ids);
    const wire = validateFullProductionVocabularyV2(
      materializeStoredVocabularyV2(rows),
    );
    expect(wire.semanticsVersion).toBe(manifest.semanticsVersion);
    expect(wire.definitions).toHaveLength(68);
    expect(wire.definitions.map((d) => d.code).sort()).toEqual(
      manifest.definitions.map((d) => d.code).sort(),
    );
    expect(wire.definitions).toEqual(
      manifest.definitions.map((d) => ({
        ...d,
        id: ids.definitions[d.code].id,
      })),
    );
    expect(wire.families).toEqual(
      manifest.families.map(({ code, label, bindings }) => ({
        code,
        label,
        id: ids.families[code],
        bindings: bindings.map((b) => ({
          ...b,
          definitionId: ids.definitions[b.definitionCode].id,
        })),
      })),
    );
    expect(ids).toEqual(before);
    expect(productionVocabularyRows(ids)).toEqual(rows);
  });

  it('carries every definition description into its storage row, outside the wire shape', () => {
    const rows = productionVocabularyRows(identities());
    expect(rows.definitions.map((d) => [d.code, d.description])).toEqual(
      manifest.definitions.map((d) => [d.code, manifest.descriptions[d.code]]),
    );
    const wire = validateFullProductionVocabularyV2(
      materializeStoredVocabularyV2(rows),
    );
    for (const d of wire.definitions)
      expect(d).not.toHaveProperty('description');
  });

  it.each(['families', 'definitions', 'units'] as const)(
    'rejects missing %s identity without mutating input',
    (kind) => {
      const ids = identities();
      delete ids[kind][Object.keys(ids[kind])[0]];
      const before = structuredClone(ids);
      expect(() => productionVocabularyRows(ids)).toThrow(
        'Invalid production vocabulary storage identity',
      );
      expect(ids).toEqual(before);
    },
  );

  it.each(['families', 'definitions', 'units'] as const)(
    'rejects duplicate %s IDs without mutating input',
    (kind) => {
      const ids = identities();
      const [a, b] = Object.keys(ids[kind]);
      if (kind === 'definitions') ids.definitions[b].id = ids.definitions[a].id;
      else ids[kind][b] = ids[kind][a];
      const before = structuredClone(ids);
      expect(() => productionVocabularyRows(ids)).toThrow(
        'Invalid production vocabulary storage identity',
      );
      expect(ids).toEqual(before);
    },
  );

  it('rejects an incompatible existing definition type', () => {
    const ids = identities();
    ids.definitions[manifest.definitions[0].code].type = 'text';
    const before = structuredClone(ids);
    expect(() => productionVocabularyRows(ids)).toThrow(
      'Invalid production vocabulary storage identity',
    );
    expect(ids).toEqual(before);
  });

  it('rejects an empty global unit ID', () => {
    const ids = identities();
    ids.units[Object.keys(ids.units)[0]] = '';
    expect(() => productionVocabularyRows(ids)).toThrow(
      'Invalid production vocabulary storage identity',
    );
  });
});
