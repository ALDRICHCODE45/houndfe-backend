/**
 * HD-EXP-02 — PORT: IExpirationIntakeRepository (UNWIRED).
 *
 * Tenant is CLS-derived; `source`/`type`/branch are server-fixed. Identity
 * `(tenantId, source, sourceRequestId)` is shared with RESTOCK (cross-type key
 * reuse is 409); the hash covers ONLY the four wire keys, so an exact replay
 * after credential rotation or a catalog rename returns the SAME snapshot.
 * The projection stays internal; the out-of-scope DTO must render the immutable
 * `PENDING`/v1 receipt. Errors are value-free.
 *
 * Design: houndfe-chatbot-human-decisions/docs/human-decisions-expiration-v1.md.
 */
import { DomainError } from '../../shared/domain/domain-error';
import {
  EXPIRATION_TYPE,
  type ExpirationIntakeRequest,
} from './expiration-intake.request';

/** Auth-derived bot source; deliberately shares the RESTOCK identity space. */
export const EXPIRATION_SOURCE = 'houndfe-chatbot';

/** NOT_FOUND->404, VALIDATION_ERROR->400, IDEMPOTENCY_CONFLICT->409. */
export type ExpirationIntakeErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND';

export class ExpirationIntakeError extends DomainError {
  constructor(code: ExpirationIntakeErrorCode, message: string) {
    super(message, code);
  }
}

/** Parsed wire request minus raw header bytes, plus the audit credential. */
export type ExpirationIntakeInput = Omit<
  ExpirationIntakeRequest,
  'originalSourceRequestId'
> & { submittedCredentialId: string };

/** Immutable server-owned snapshot; no SKU, one `productUnit` for both kinds. */
export interface ExpirationIntakeSnapshot {
  branchId: string;
  branchName: string | null;
  productId: string;
  productName: string;
  productUnit: string;
  variantId: string | null;
  variantName: string | null;
  variantOption: string | null;
  variantValue: string | null;
}

export interface PersistedExpirationDecision {
  id: string;
  source: typeof EXPIRATION_SOURCE;
  sourceRequestId: string;
  type: typeof EXPIRATION_TYPE;
  canonicalRequestHash: string;
  status: 'PENDING' | 'RESOLVED';
  version: number;
  createdAt: Date;
  snapshot: ExpirationIntakeSnapshot;
}

/** `created`->201; `replayed`->200 with the same historical receipt. */
export type ExpirationIntakeResult =
  | { status: 'created'; request: PersistedExpirationDecision }
  | { status: 'replayed'; request: PersistedExpirationDecision };

export interface IExpirationIntakeRepository {
  submit(input: ExpirationIntakeInput): Promise<ExpirationIntakeResult>;
}

/** Injection token used by NestJS DI to resolve the interface. */
export const EXPIRATION_INTAKE_REPOSITORY = Symbol(
  'EXPIRATION_INTAKE_REPOSITORY',
);
