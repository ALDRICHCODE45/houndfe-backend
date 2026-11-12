/**
 * Port: list the objects under the conversation media prefix, page by page, for
 * the orphan sweep (S2). The receipts storage port has no listing and
 * `src/receipts` is not touched, so this is the conversations module's own,
 * read-only capability over the same bucket.
 */
export const CONVERSATION_MEDIA_LISTER = Symbol('CONVERSATION_MEDIA_LISTER');

export interface ListedObject {
  key: string;
  /** `null` when the store does not say: such an object is never swept. */
  lastModified: Date | null;
}

export interface ConversationMediaLister {
  /**
   * Keys in ascending order, strictly after `startAfter`, at most `limit`.
   * `truncated` is true when more keys follow this page.
   */
  list(input: {
    prefix: string;
    startAfter: string | null;
    limit: number;
  }): Promise<{ objects: ListedObject[]; truncated: boolean }>;
}
