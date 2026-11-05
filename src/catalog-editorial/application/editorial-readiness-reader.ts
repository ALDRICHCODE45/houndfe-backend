import type { EditorialContext } from './catalog-editorial-core';
import type { ReadinessV2 } from './editorial-publication-readiness-v2';

export const EDITORIAL_READINESS_READER = Symbol('EDITORIAL_READINESS_READER');

/** Read-only evaluation of the saved Draft after current authority and request admission. */
export interface EditorialReadinessReader {
  read(
    scope: EditorialContext,
    vocabularyRevision: string,
  ): Promise<ReadinessV2>;
}
