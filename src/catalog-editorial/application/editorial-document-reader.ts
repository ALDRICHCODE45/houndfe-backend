import type { EditorialContext } from './catalog-editorial-core';
import type { StateV2 } from './editorial-state-v2';

export const EDITORIAL_DOCUMENT_READER = Symbol('EDITORIAL_DOCUMENT_READER');

/** Read-only snapshot after current authority and raw request admission. */
export interface EditorialDocumentReader {
  read(scope: EditorialContext, vocabularyRevision: string): Promise<StateV2>;
}
