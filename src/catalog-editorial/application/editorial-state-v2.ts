import type { ArchivedOptionWarning } from '../domain/contextual-document';
import {
  classifyEditorialDocumentMode,
  type EditorialDocumentJson,
} from '../domain/editorial-document-mode';
import type { DocumentShapeV2 } from '../domain/editorial-document-shape-v2';

export type DocumentViewV2 =
  | { mode: 'legacy'; document: EditorialDocumentJson }
  | { mode: 'production-v2'; document: DocumentShapeV2 }
  | { mode: 'unsupported'; document: EditorialDocumentJson };

export type EditorialStateV2 = {
  cycle: number | null;
  draft: {
    revision: number;
    basePublishedRevision: number | null;
    document: DocumentViewV2;
  } | null;
  published: { revision: number; document: DocumentViewV2 } | null;
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

function documentView(document: EditorialDocumentJson): DocumentViewV2 {
  const mode = classifyEditorialDocumentMode(document);
  const copy = copyJson(document);
  if (mode === 'production-v2') {
    // The real classifier established this shape; copyJson preserves it verbatim.
    return { mode, document: copy as DocumentShapeV2 };
  }
  return { mode, document: copy };
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
            document: documentView(input.draft.document),
          },
    published:
      input.published === null
        ? null
        : {
            revision: input.published.revision,
            document: documentView(input.published.document),
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
