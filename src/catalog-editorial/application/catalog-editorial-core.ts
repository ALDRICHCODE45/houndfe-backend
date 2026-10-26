import type { DocumentAuthority, EditorialDocument } from '../domain/document';

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
export interface EditorialCreateAuthority {
  resolve(context: EditorialContext): Promise<
    | (EditorialContext & {
        activeMember: boolean;
        canCreate: boolean;
        documentAuthority: DocumentAuthority;
      })
    | null
  >;
}
export interface EditorialCreateRequest {
  expectedCycle: number | null;
  idempotencyKey: string;
  document: unknown;
}
export interface EditorialSaveAuthority {
  resolve(context: EditorialContext): Promise<
    | (EditorialContext & {
        activeMember: boolean;
        canSave: boolean;
        documentAuthority: DocumentAuthority;
      })
    | null
  >;
}
export interface EditorialSaveRequest extends EditorialCreateRequest {
  expectedCycle: number;
  expectedRevision: number;
}
/** Internal callable boundary only; no transport or effective grants. */
export interface CatalogEditorialCore {
  read(context: EditorialContext): Promise<EditorialReadResult>;
  save(
    context: EditorialContext,
    request: EditorialSaveRequest,
  ): Promise<EditorialReadResult>;
  create(
    context: EditorialContext,
    request: EditorialCreateRequest,
  ): Promise<EditorialReadResult>;
}
