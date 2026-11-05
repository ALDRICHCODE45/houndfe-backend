import type { ArchivedOptionWarning } from './contextual-document';
import { fail, type DocumentAuthority } from './document';
import { eligibleConservationBaselineV2 } from './editorial-conservation-baseline-v2';
import type { DocumentShapeV2 } from './editorial-document-shape-v2';
import type { VocabularyV2 } from './editorial-vocabulary-shape-v2';

export type ArchivedOptionProblemV2 = {
  code: string;
  variantId: string | null;
  optionCode: string;
};

/**
 * Conservation that collects every archived option the baseline does not retain.
 * Unbound or unknown options are not collectable: they still throw MALFORMED.
 */
export function collectArchivedOptionConservationV2(
  candidate: DocumentShapeV2,
  baselineInput: unknown,
  references: Pick<DocumentAuthority, 'variantIds' | 'assetIds'>,
  vocabulary: Pick<VocabularyV2, 'families' | 'definitions'>,
): { warnings: ArchivedOptionWarning[]; problems: ArchivedOptionProblemV2[] } {
  const problems: ArchivedOptionProblemV2[] = [];
  const baseline = eligibleConservationBaselineV2(
    baselineInput,
    references,
    vocabulary,
  );
  const warnings: ArchivedOptionWarning[] = [];
  const family = vocabulary.families.find(
    (item) => item.code === candidate.familyCode,
  );
  for (const value of candidate.values) {
    if (value.state !== 'known') continue;
    const payload = value.payload;
    if (payload.type !== 'single' && payload.type !== 'multi') continue;
    const binding = family?.bindings.find(
      (item) => item.definitionCode === value.code,
    );
    const definition = vocabulary.definitions.find(
      (item) => item.id === binding?.definitionId,
    );
    if (
      !family ||
      !definition ||
      (definition.type !== 'single' && definition.type !== 'multi')
    )
      fail('MALFORMED');
    const options = payload.type === 'single' ? [payload.value] : payload.value;
    for (const optionCode of options) {
      const option = definition.options.find(
        (item) => item.code === optionCode,
      );
      if (!option) fail('MALFORMED');
      if (!option.archived) continue;
      const previous =
        baseline?.familyCode === candidate.familyCode
          ? baseline.values.find(
              (item) =>
                item.code === value.code &&
                item.owner === value.owner &&
                item.variantId === value.variantId &&
                item.state === 'known' &&
                item.payload.type === payload.type,
            )
          : undefined;
      const retained =
        previous?.state === 'known' &&
        (previous.payload.type === 'single'
          ? previous.payload.value === optionCode
          : previous.payload.type === 'multi' &&
            previous.payload.value.includes(optionCode));
      if (!retained) {
        problems.push({
          code: value.code,
          variantId: value.variantId,
          optionCode,
        });
        continue;
      }
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
  return { warnings, problems };
}

/** Reference-admitted candidate; caller owns stored baseline provenance. */
export function conserveArchivedOptionsV2(
  candidate: DocumentShapeV2,
  baselineInput: unknown,
  references: Pick<DocumentAuthority, 'variantIds' | 'assetIds'>,
  vocabulary: Pick<VocabularyV2, 'families' | 'definitions'>,
): ArchivedOptionWarning[] {
  const { warnings, problems } = collectArchivedOptionConservationV2(
    candidate,
    baselineInput,
    references,
    vocabulary,
  );
  if (problems.length) fail('MALFORMED');
  return warnings;
}
