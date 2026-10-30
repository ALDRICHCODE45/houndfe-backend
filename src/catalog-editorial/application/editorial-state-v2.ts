import type { ArchivedOptionWarning } from '../domain/contextual-document';
import type { EditorialDocumentJson } from '../domain/editorial-document-mode';
import { isRecognizableDocumentV2 } from '../domain/editorial-document-recognition-v2';
import type { DocumentShapeV2 } from '../domain/editorial-document-shape-v2';

export type EditorialStateV2 = {
  cycle: number | null;
  draft: {
    revision: number;
    basePublishedRevision: number | null;
    document: DocumentShapeV2;
  } | null;
  published: { revision: number; document: DocumentShapeV2 } | null;
  warnings?: ArchivedOptionWarning[];
};

export type StateV2 = {
  contractVersion: 2;
  vocabularyRevision: string;
  state: EditorialStateV2;
};

/** Decoded finite acyclic JSON and well-formed persisted counters/warnings. */
export type RawStoredEditorialStateV2 = {
  cycle: number | null;
  draft: {
    revision: number;
    basePublishedRevision: number | null;
    document: EditorialDocumentJson;
  } | null;
  published: { revision: number; document: EditorialDocumentJson } | null;
  warnings?: ArchivedOptionWarning[];
};

function copyJson(value: EditorialDocumentJson): EditorialDocumentJson {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(copyJson);
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, copyJson(child)]),
  );
}

function copyDocument(document: EditorialDocumentJson): DocumentShapeV2 {
  if (!isRecognizableDocumentV2(document))
    throw new TypeError('Expected an editorial document V2');
  // Recognition establishes the shape; copy rather than reconstruct historical data.
  return copyJson(document) as DocumentShapeV2;
}

/** Fresh response composition only; vocabularyRevision is already admitted. */
export function createEditorialStateV2(
  vocabularyRevision: string,
  input: RawStoredEditorialStateV2,
): StateV2 {
  const state: EditorialStateV2 = {
    cycle: input.cycle,
    draft:
      input.draft === null
        ? null
        : {
            revision: input.draft.revision,
            basePublishedRevision: input.draft.basePublishedRevision,
            document: copyDocument(input.draft.document),
          },
    published:
      input.published === null
        ? null
        : {
            revision: input.published.revision,
            document: copyDocument(input.published.document),
          },
  };
  if (input.warnings?.length) {
    state.warnings = input.warnings.map((warning) => ({
      code: warning.code,
      familyId: warning.familyId,
      definitionId: warning.definitionId,
      owner: warning.owner,
      variantId: warning.variantId,
      optionCode: warning.optionCode,
    }));
  }
  return { contractVersion: 2, vocabularyRevision, state };
}
