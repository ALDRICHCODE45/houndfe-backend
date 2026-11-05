import type { Prisma } from '@prisma/client';
import type { EditorialContext } from '../application/catalog-editorial-core';
import {
  presentPublicationReadinessV2,
  type ReadinessV2,
} from '../application/editorial-publication-readiness-v2';
import { EditorialDocumentShapeError } from '../domain/editorial-document-shape-error';
import {
  parseDocumentShapeV2,
  type DocumentShapeV2,
} from '../domain/editorial-document-shape-v2';
import {
  evaluatePublicationReadinessV2,
  type PublicationProblemV2,
} from '../domain/editorial-publication-readiness-v2';
import type { VocabularyV2 } from '../domain/editorial-vocabulary-shape-v2';
import { readEditorialOfferedSubjectsV2 } from './prisma-editorial-offered-subjects-v2';
import {
  readEditorialReferencesSnapshot,
  readLockedEditorialReferences,
} from './prisma-locked-editorial-references';

export type SavedDraftV2 = {
  cycle: number | null;
  /** Null when there is no saved Draft. */
  draftRevision: number | null;
  draftDocument: unknown;
  publishedDocument: unknown;
};

const productItem = (
  problem: PublicationProblemV2['problem'],
): PublicationProblemV2 => ({
  scope: 'product',
  definitionCode: null,
  variantId: null,
  problem,
  detail: null,
});

/**
 * The one readiness evaluation of a saved Draft, shared by the readiness GET
 * (snapshot references) and publish (locked references, under its gates).
 * `document` and E are returned only when the Draft was evaluated.
 */
export async function assessSavedDraftV2(
  tx: Prisma.TransactionClient,
  scope: EditorialContext,
  state: SavedDraftV2 | undefined,
  current: {
    vocabularyRevision: string;
    vocabulary: Pick<VocabularyV2, 'families' | 'definitions'>;
  },
  references: 'locked' | 'snapshot',
): Promise<{
  readiness: ReadinessV2;
  document: DocumentShapeV2 | null;
  offeredSubjects: (string | null)[];
}> {
  const meta = {
    cycle: state?.cycle ?? null,
    draftRevision: state?.draftRevision ?? null,
    vocabularyRevision: current.vocabularyRevision,
    definitions: current.vocabulary.definitions,
  };
  const only = (problem: PublicationProblemV2['problem']) => ({
    readiness: presentPublicationReadinessV2({
      ...meta,
      familyCode: null,
      problems: [productItem(problem)],
    }),
    document: null,
    offeredSubjects: [],
  });
  // No saved Draft: one product item, like the read's null draft.
  if (!state || state.draftRevision === null) return only('NO_DRAFT');
  let document: DocumentShapeV2;
  try {
    document = parseDocumentShapeV2(state.draftDocument);
  } catch (error) {
    if (!(error instanceof EditorialDocumentShapeError)) throw error;
    return only('DRAFT_INVALID');
  }
  const read =
    references === 'locked'
      ? readLockedEditorialReferences
      : readEditorialReferencesSnapshot;
  const observed = await read(tx, scope, document.mediaRefs);
  const offeredSubjects = await readEditorialOfferedSubjectsV2(tx, scope);
  const problems = evaluatePublicationReadinessV2({
    document,
    references: observed,
    vocabulary: current.vocabulary,
    offeredSubjects,
    publishedDocument: state.publishedDocument,
  });
  return {
    readiness: presentPublicationReadinessV2({
      ...meta,
      familyCode: document.familyCode,
      problems,
    }),
    document,
    offeredSubjects,
  };
}
