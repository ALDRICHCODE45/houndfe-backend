import type { DocumentAuthority, EditorialDocument } from '../domain/document';
import type { ArchivedOptionWarning } from '../domain/contextual-document';

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
  /** Current contextual warnings for the returned Draft, when present. */
  warnings?: ArchivedOptionWarning[];
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
/** Explicit persisted Published/empty initialization; no caller document or baseline. */
export interface EditorialInitializeRequest {
  expectedCycle: number | null;
  idempotencyKey: string;
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
export interface EditorialTransitionRequest {
  expectedCycle: number;
  expectedRevision: number;
  idempotencyKey: string;
}
export interface EditorialTransitionAuthority {
  resolve(context: EditorialContext): Promise<
    | (ReadAuthoritySnapshot & { canPublish: boolean; canDiscard: boolean })
    | null
  >;
}
/** Internal callable boundary only; no transport or effective grants. */
export interface CatalogEditorialCore {
  publish(
    context: EditorialContext,
    request: EditorialTransitionRequest,
  ): Promise<EditorialReadResult>;
  discard(
    context: EditorialContext,
    request: EditorialTransitionRequest,
  ): Promise<EditorialReadResult>;
  initialize(
    context: EditorialContext,
    request: EditorialInitializeRequest,
  ): Promise<EditorialReadResult>;
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
