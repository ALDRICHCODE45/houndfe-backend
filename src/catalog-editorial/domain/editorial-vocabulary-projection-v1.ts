type DefinitionIdentity = { id: string; code: string; label: string };
type UnitV1 = { code: string | null; label: string | null; sortOrder: number };
type OptionV1 = {
  code: string;
  label: string;
  archived: boolean;
  sortOrder: number;
};
type BindingV1 = {
  definitionId: string;
  definitionCode: string;
  owner: 'product' | 'sellable';
  sortOrder: number;
};
type FamilyV1 = {
  id: string;
  code: string;
  label: string;
  bindings: BindingV1[];
};
type DefinitionV1 = DefinitionIdentity &
  (
    | { type: 'text' | 'boolean' }
    | { type: 'number'; units: UnitV1[] }
    | { type: 'single' | 'multi'; options: OptionV1[] }
  );
export type VocabularyV1 = {
  families: FamilyV1[];
  definitions: DefinitionV1[];
};

/** Persisted JSONB shape, not the stricter V2 numeric DTO. */
type PersistedNumericPolicy =
  | { readonly status: 'pending' }
  | {
      readonly status: 'resolved';
      readonly magnitude: string;
      readonly integer: boolean;
      readonly lower: number | null;
      readonly lowerInclusive: boolean;
      readonly upper: number | null;
      readonly upperInclusive: boolean;
    };
export type VocabularyReadDefinition = Readonly<DefinitionIdentity> &
  (
    | { readonly type: 'text' | 'boolean' }
    | {
        readonly type: 'number' | 'range';
        readonly units: readonly Readonly<UnitV1>[];
        readonly numericPolicy?: PersistedNumericPolicy | null;
      }
    | {
        readonly type: 'single' | 'multi';
        readonly options: readonly Readonly<OptionV1>[];
      }
  );
export type VocabularyReadSnapshot = {
  readonly families: readonly {
    readonly id: string;
    readonly code: string;
    readonly label: string;
    readonly minimumContractVersion: 1 | 2;
    readonly bindings: readonly Readonly<BindingV1>[];
  }[];
  readonly definitions: readonly VocabularyReadDefinition[];
};

/** Trusted coherent, reader-ordered snapshot; not admission or compatibility validation. */
export function projectVocabularyV1(
  snapshot: VocabularyReadSnapshot,
): VocabularyV1 {
  const originallyBound = new Set<string>();
  const retained = new Set<string>();
  for (const family of snapshot.families) {
    for (const binding of family.bindings) {
      originallyBound.add(binding.definitionId);
      if (family.minimumContractVersion === 1)
        retained.add(binding.definitionId);
    }
  }
  const families = snapshot.families
    .filter((family) => family.minimumContractVersion === 1)
    .map(({ id, code, label, bindings }) => ({
      id,
      code,
      label,
      bindings: bindings.map(
        ({ definitionId, definitionCode, owner, sortOrder }) => ({
          definitionId,
          definitionCode,
          owner,
          sortOrder,
        }),
      ),
    }));
  const definitions: DefinitionV1[] = [];
  for (const definition of snapshot.definitions) {
    const unboundLegacy =
      !originallyBound.has(definition.id) &&
      definition.type !== 'range' &&
      (definition.type !== 'number' ||
        definition.numericPolicy == null ||
        definition.numericPolicy.status === 'pending');
    if (!retained.has(definition.id) && !unboundLegacy) continue;
    const { id, code, label } = definition;
    switch (definition.type) {
      case 'range':
        throw new Error('V1 projection precondition: retained range');
      case 'number':
        definitions.push({
          id,
          code,
          label,
          type: definition.type,
          units: definition.units.map(({ code, label, sortOrder }) => ({
            code,
            label,
            sortOrder,
          })),
        });
        break;
      case 'single':
      case 'multi':
        definitions.push({
          id,
          code,
          label,
          type: definition.type,
          options: definition.options.map(
            ({ code, label, archived, sortOrder }) => ({
              code,
              label,
              archived,
              sortOrder,
            }),
          ),
        });
        break;
      case 'text':
      case 'boolean':
        definitions.push({ id, code, label, type: definition.type });
    }
  }
  return { families, definitions };
}
