import type { EditorialDocument } from '../domain/document';

export interface EditorialContext {
  actorId: string;
  tenantId: string;
  productId: string;
}
export interface ReadAuthoritySnapshot extends EditorialContext {
  /** True only for an active actor with current tenant membership. */
  activeMember: boolean;
  canRead: boolean;
}
/** Integration must resolve current actor membership and explicit capability. */
export interface EditorialReadAuthority {
  resolve(context: EditorialContext): Promise<ReadAuthoritySnapshot | null>;
}
export interface EditorialReadResult {
  cycle: number | null;
  draft: {
    revision: number;
    basePublishedRevision: number | null;
    document: EditorialDocument;
  } | null;
  published: { revision: number; document: EditorialDocument } | null;
}
/** Internal callable boundary only; no transport or effective grants. */
export interface CatalogEditorialCore {
  read(context: EditorialContext): Promise<EditorialReadResult>;
}
