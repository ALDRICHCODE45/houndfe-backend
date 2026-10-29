import type { EditorialValue } from './document';
import type { DocumentShapeV2 } from './editorial-document-shape-v2';
import type { KnownPayloadV2 } from './editorial-known-payload-shape-v2';
import { isRecognizableLegacyDocument } from './editorial-legacy-document-recognition';

function copyPayload(value: EditorialValue): KnownPayloadV2 {
  switch (value.type) {
    case 'text':
      return { type: 'text', value: value.value };
    case 'boolean':
      return { type: 'boolean', value: value.value };
    case 'number':
      return { type: 'number', value: value.value, unit: value.unit };
    case 'single':
      return { type: 'single', value: value.value };
    case 'multi':
      return { type: 'multi', value: value.value.slice() };
  }
}

/** Explicit opt-in preparation only: this mutable buffer is not save authority. */
export function createLegacyAdoptionBuffer(input: unknown): DocumentShapeV2 {
  if (!isRecognizableLegacyDocument(input))
    throw new TypeError('Expected a recognizable legacy document');
  return {
    schemaVersion: 2,
    commercialTitle: input.commercialTitle,
    description: input.description,
    mediaRefs: input.mediaRefs.slice(),
    familyCode: input.familyCode,
    values: input.values.map((value) => ({
      code: value.code,
      owner: value.owner,
      variantId: value.variantId,
      state: 'known',
      payload: copyPayload(value),
      evidence: null,
    })),
    facts: [],
  };
}
