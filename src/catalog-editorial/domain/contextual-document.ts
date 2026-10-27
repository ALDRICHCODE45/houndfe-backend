import { fail, validateDocument } from './document';
import type {
  Definition,
  DocumentAuthority,
  EditorialDocument,
  Owner,
} from './document';
import type { EditorialDefinitionsSnapshot } from './editorial-definitions';

export interface ArchivedOptionWarning {
  code: 'ARCHIVED_OPTION';
  familyId: string;
  definitionId: string;
  owner: Owner;
  variantId: string | null;
  optionCode: string;
}
export interface ContextualDocumentResult {
  document: EditorialDocument;
  warnings: ArchivedOptionWarning[];
}

/** Strict code/reference projection, never an archived-assignment allowlist. */
export function projectDefinitionFamilies(
  definitions: EditorialDefinitionsSnapshot,
): DocumentAuthority['families'] {
  return definitions.families.map((family) => ({
    code: family.code,
    attributes: family.bindings.map((binding): Definition => {
      const definition = definitions.definitions.find(
        (d) => d.id === binding.definitionId,
      );
      if (!definition) return fail('MALFORMED');
      const common = { code: definition.code, owner: binding.owner };
      switch (definition.type) {
        case 'text':
        case 'boolean':
          return { ...common, type: definition.type };
        case 'number':
          return { ...common, type: 'number', units: definition.units };
        default:
          return {
            ...common,
            type: definition.type,
            codes: definition.options.map((o) => o.code),
          };
      }
    }),
  }));
}

/** Baseline provenance is the caller's responsibility; this pure function cannot prove it. */
export function validateContextualDocument(
  input: unknown,
  references: Omit<DocumentAuthority, 'families'>,
  definitions: EditorialDefinitionsSnapshot,
  baseline: EditorialDocument | null,
): ContextualDocumentResult {
  const families = projectDefinitionFamilies(definitions);
  // The temporary code projection is only a strict shape/reference check.
  // It is never returned as an assignment allowlist.
  const document = validateDocument(input, { ...references, families });
  const warnings: ArchivedOptionWarning[] = [];
  const family = definitions.families.find(
    (f) => f.code === document.familyCode,
  );
  for (const value of document.values) {
    if (value.type !== 'single' && value.type !== 'multi') continue;
    const definition = definitions.definitions.find(
      (d) => d.code === value.code,
    );
    if (
      !family ||
      !definition ||
      (definition.type !== 'single' && definition.type !== 'multi')
    )
      fail('MALFORMED');
    const options = value.type === 'single' ? [value.value] : value.value;
    for (const optionCode of options) {
      if (!definition.options.find((o) => o.code === optionCode)?.archived)
        continue;
      const previous =
        baseline?.familyCode === document.familyCode
          ? baseline.values.find(
              (v) =>
                v.code === value.code &&
                v.owner === value.owner &&
                v.variantId === value.variantId &&
                v.type === value.type,
            )
          : undefined;
      const retained =
        previous?.type === 'single'
          ? previous.value === optionCode
          : previous?.type === 'multi' && previous.value.includes(optionCode);
      if (!retained) fail('MALFORMED');
      warnings.push({
        code: 'ARCHIVED_OPTION',
        familyId: family.id,
        definitionId: definition.id,
        owner: value.owner,
        variantId: value.variantId,
        optionCode,
      });
    }
  }
  return { document, warnings };
}
