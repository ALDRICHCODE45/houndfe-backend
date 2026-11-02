import { buildProductionVocabularyManifest } from './editorial-production-vocabulary.manifest';
import { materializeStoredVocabularyV2 } from '../src/catalog-editorial/domain/editorial-vocabulary-stored-root-v2';
import { validateFullProductionVocabularyV2 } from '../src/catalog-editorial/domain/editorial-vocabulary-full-production-v2';

export interface VocabularyStorageIdentities {
  families: Record<string, string>;
  definitions: Record<string, { id: string; type: string }>;
  units: Record<string, string>;
}

/** Pure canonical defaults only; not a merge, ID allocator or apply command. */
export function productionVocabularyRows(
  identities: VocabularyStorageIdentities,
) {
  const manifest = buildProductionVocabularyManifest();
  const used = {
    families: new Set<string>(),
    definitions: new Set<string>(),
    units: new Set<string>(),
  };
  const invalid = (): never => {
    throw new TypeError('Invalid production vocabulary storage identity');
  };
  const claim = (kind: keyof typeof used, id: unknown): string => {
    if (typeof id !== 'string' || !id.trim() || used[kind].has(id)) {
      return invalid();
    }
    used[kind].add(id);
    return id;
  };
  const definitions = manifest.definitions.map((d) => {
    const identity = identities.definitions[d.code];
    if (!identity || identity.type !== d.type) invalid();
    const id = claim('definitions', identity.id);
    const parent = { definitionId: id, definitionType: d.type };
    return {
      id,
      code: d.code,
      label: d.label,
      type: d.type,
      numericPolicy: 'numericPolicy' in d ? d.numericPolicy : null,
      units:
        'units' in d
          ? d.units.map(({ code, ...u }) => ({
              ...parent,
              ...u,
              unitCode: code,
              id: claim(
                'units',
                identities.units[JSON.stringify([d.code, code])],
              ),
            }))
          : [],
      options:
        'options' in d
          ? d.options.map(({ code, label, sortOrder }) => ({
              ...parent,
              code,
              label,
              sortOrder,
              archivedAt: null,
            }))
          : [],
      groups:
        'groups' in d
          ? d.groups.map(({ optionCodes, ...g }) => ({
              ...parent,
              ...g,
              members: optionCodes.map((optionCode) => ({
                definitionId: id,
                groupCode: g.code,
                optionCode,
              })),
            }))
          : [],
      aliases:
        'aliases' in d
          ? d.aliases.map((a) => ({ definitionId: id, ...a }))
          : [],
    };
  });
  const families = manifest.families.map(({ bindings, ...f }) => {
    const id = claim('families', identities.families[f.code]);
    return {
      ...f,
      id,
      bindings: bindings.map((b) => ({
        ...b,
        familyId: id,
        definitionId: identities.definitions[b.definitionCode].id,
      })),
    };
  });
  const rows = {
    metadata: { id: 'global', semanticsVersion: manifest.semanticsVersion },
    families,
    definitions,
  };
  validateFullProductionVocabularyV2(materializeStoredVocabularyV2(rows));
  return rows;
}
