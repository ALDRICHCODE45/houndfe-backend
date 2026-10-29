import { fail, type DocumentAuthority } from './document';
import type { DocumentShapeV2 } from './editorial-document-shape-v2';
import type { VocabularyV2 } from './editorial-vocabulary-shape-v2';

/** Reference membership only; callers establish parsed inputs and stable authority. */
export function assertFreshDocumentReferencesV2(
  candidate: DocumentShapeV2,
  references: Pick<DocumentAuthority, 'variantIds' | 'assetIds'>,
  vocabulary: Pick<VocabularyV2, 'families' | 'definitions'>,
): void {
  const assets = new Set(references.assetIds);
  const media = new Set<string>();
  for (const id of candidate.mediaRefs) {
    if (media.has(id) || !assets.has(id)) fail('MALFORMED');
    media.add(id);
  }
  if (candidate.familyCode === null) {
    if (candidate.values.length || candidate.facts.length) fail('MALFORMED');
    return;
  }
  const family = vocabulary.families.find(
    (f) => f.code === candidate.familyCode,
  );
  if (!family) fail('MALFORMED');
  const definitions = new Map(vocabulary.definitions.map((d) => [d.id, d]));
  const bindings = new Map(family.bindings.map((b) => [b.definitionCode, b]));
  const variants = new Set(references.variantIds);
  const isSellableSubject = (id: string | null): boolean =>
    variants.size ? id !== null && variants.has(id) : id === null;
  const keys = new Set<string>();
  for (const value of candidate.values) {
    // Serialize only the identity tuple: owner is deliberately not part of it.
    const key = JSON.stringify([value.code, value.variantId]);
    if (keys.has(key)) fail('MALFORMED');
    keys.add(key);
    const binding = bindings.get(value.code);
    if (!binding || binding.owner !== value.owner) fail('MALFORMED');
    const definition = definitions.get(binding.definitionId);
    if (!definition || definition.code !== binding.definitionCode)
      fail('MALFORMED');
    if (
      value.owner === 'product'
        ? value.variantId !== null
        : !isSellableSubject(value.variantId)
    )
      fail('MALFORMED');
    if (value.state !== 'known') continue;
    const payload = value.payload;
    if (payload.type !== definition.type) fail('MALFORMED');
    if (payload.type === 'number' || payload.type === 'range') {
      if (
        (definition.type !== 'number' && definition.type !== 'range') ||
        !definition.units.some((unit) => unit.code === payload.unit)
      )
        fail('MALFORMED');
    }
    if (payload.type === 'single' || payload.type === 'multi') {
      if (definition.type !== 'single' && definition.type !== 'multi')
        fail('MALFORMED');
      // Archived options are members too; conservation/permission is a later gate.
      const options = new Set(definition.options.map((option) => option.code));
      const codes = payload.type === 'single' ? [payload.value] : payload.value;
      if (
        new Set(codes).size !== codes.length ||
        codes.some((code) => !options.has(code))
      )
        fail('MALFORMED');
    }
  }
  const subjects = new Set<string | null>();
  for (const fact of candidate.facts) {
    if (subjects.has(fact.variantId) || !isSellableSubject(fact.variantId))
      fail('MALFORMED');
    subjects.add(fact.variantId);
  }
}
