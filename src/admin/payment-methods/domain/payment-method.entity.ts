/**
 * ENTITY: PaymentMethod (Aggregate Root) — custom-payment-methods / WU1.
 *
 * Tenant-scoped tender-method catalog row (e.g. "Mercado Pago" mapped to
 * `transfer`). Mirrors the `PaymentDetail` aggregate pattern (static
 * `create()` + `fromPersistence()` + mutators that bump `_updatedAt`).
 *
 * BUSINESS RULES (from `specs/payment-methods/spec.md` — Field Validation):
 *   - `name` MUST be a non-empty string after trim; max 60 chars.
 *   - `category` MUST be one of `cash | card_credit | card_debit |
 *     transfer` (NEVER `credit`; the `PaymentMethodCategory` enum enforces
 *     this structurally).
 *   - `subtitle` MAY be null; max 120 chars when supplied.
 *   - `isActive @default(true)`; delete is logical (`isActive=false`).
 *
 * LIFECYCLE (D2):
 *   - `update()` accepts partial input INCLUDING `isActive`, so a
 *     deactivated row can be re-activated via PATCH `{ isActive: true }`
 *     (unlike `PaymentDetail.update`, which omits `isActive` because the
 *     reactivation scenario doesn't apply there).
 *   - `deactivate()` flips `isActive` and is idempotent.
 *   - No hard delete; the spec scenario "Renaming a catalog row does not
 *     rewrite history" relies on the row surviving deactivation.
 */
import {
  BusinessRuleViolationError,
  InvalidArgumentError,
} from '../../../shared/domain/domain-error';

export const PAYMENT_METHOD_CATEGORIES = [
  'cash',
  'card_credit',
  'card_debit',
  'transfer',
] as const;

export type PaymentMethodCategory =
  | 'cash'
  | 'card_credit'
  | 'card_debit'
  | 'transfer';

export interface PaymentMethodProps {
  id: string;
  tenantId: string;
  name: string;
  category: PaymentMethodCategory;
  subtitle: string | null;
  isActive: boolean;
  metadataJson: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePaymentMethodInput {
  id: string;
  tenantId: string;
  name: string;
  category: PaymentMethodCategory;
  subtitle?: string | null;
  metadataJson?: Record<string, unknown> | null;
}

export interface UpdatePaymentMethodInput {
  name?: string;
  category?: PaymentMethodCategory;
  subtitle?: string | null;
  isActive?: boolean;
  metadataJson?: Record<string, unknown> | null;
}

export class PaymentMethod {
  private constructor(
    public readonly id: string,
    public readonly tenantId: string,
    private _name: string,
    private _category: PaymentMethodCategory,
    private _subtitle: string | null,
    private _isActive: boolean,
    private _metadataJson: Record<string, unknown> | null,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Factory: validate + create a NEW active `PaymentMethod`
   * (`isActive=true`, `metadataJson=null` when omitted). Mirrors
   * `PaymentDetail.create`: `id` and `tenantId` are required at
   * construction so the entity is self-scoped (the prisma adapter
   * re-injects the tenantId via the tenant-scoped client, but having
   * it here keeps the entity self-contained).
   */
  static create(input: CreatePaymentMethodInput): PaymentMethod {
    if (!input.id || input.id.trim() === '') {
      throw new InvalidArgumentError('PaymentMethod id is required');
    }
    if (!input.tenantId || input.tenantId.trim() === '') {
      throw new InvalidArgumentError('PaymentMethod tenantId is required');
    }

    const name = sanitizeName(input.name);
    const category = sanitizeCategory(input.category);
    const subtitle = sanitizeSubtitle(input.subtitle ?? null);
    const metadataJson = input.metadataJson ?? null;

    const now = new Date();
    return new PaymentMethod(
      input.id,
      input.tenantId,
      name,
      category,
      subtitle,
      true,
      metadataJson,
      now,
      now,
    );
  }

  /** Factory: reconstruct from DB (skips validation). */
  static fromPersistence(props: PaymentMethodProps): PaymentMethod {
    return new PaymentMethod(
      props.id,
      props.tenantId,
      props.name,
      props.category,
      props.subtitle,
      props.isActive,
      props.metadataJson,
      props.createdAt,
      props.updatedAt,
    );
  }

  // ── Getters ─────────────────────────────────────────────────────────

  get name(): string {
    return this._name;
  }

  get category(): PaymentMethodCategory {
    return this._category;
  }

  get subtitle(): string | null {
    return this._subtitle;
  }

  get isActive(): boolean {
    return this._isActive;
  }

  get metadataJson(): Record<string, unknown> | null {
    return this._metadataJson;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ── Mutators ────────────────────────────────────────────────────────

  /**
   * Apply a partial update. Only the supplied fields are mutated; the
   * rest stay unchanged. `updatedAt` is bumped on every call (matches the
   * "updatedAt DESC = most-recent activity" ordering used by
   * `findAll`). `isActive` IS mutable here (D2 — reactivation scenario);
   * `PaymentDetail.update` deliberately omits it.
   */
  update(input: UpdatePaymentMethodInput): PaymentMethod {
    if (input.name !== undefined) {
      this._name = sanitizeName(input.name);
    }
    if (input.category !== undefined) {
      this._category = sanitizeCategory(input.category);
    }
    if (input.subtitle !== undefined) {
      this._subtitle = sanitizeSubtitle(input.subtitle);
    }
    if (input.metadataJson !== undefined) {
      this._metadataJson = input.metadataJson;
    }
    if (input.isActive !== undefined) {
      this._isActive = input.isActive;
    }
    this._updatedAt = new Date();
    return this;
  }

  /**
   * Logical delete (D2): flips `isActive` to `false`. Idempotent — calling
   * `deactivate()` on an already-inactive row is a no-op (no extra
   * `updatedAt` bump; preserves the audit ordering).
   */
  deactivate(): PaymentMethod {
    if (this._isActive) {
      this._isActive = false;
      this._updatedAt = new Date();
    }
    return this;
  }

  // ── Serialization ───────────────────────────────────────────────────

  toResponse() {
    return {
      id: this.id,
      tenantId: this.tenantId,
      name: this._name,
      category: this._category,
      subtitle: this._subtitle,
      isActive: this._isActive,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this._updatedAt.toISOString(),
    };
  }

  toPersistence(): {
    id: string;
    tenantId: string;
    name: string;
    category: 'CASH' | 'CARD_CREDIT' | 'CARD_DEBIT' | 'TRANSFER';
    subtitle: string | null;
    isActive: boolean;
    metadataJson: Record<string, unknown> | null;
    createdAt: Date;
    updatedAt: Date;
  } {
    return {
      id: this.id,
      tenantId: this.tenantId,
      name: this._name,
      // Persisted shape (Prisma enum): uppercase. The 4-value enum guard
      // in `sanitizeCategory` keeps this a closed set; the `as` is the
      // narrowest possible coercion (validated at construction).
      category: this._category.toUpperCase() as
        | 'CASH'
        | 'CARD_CREDIT'
        | 'CARD_DEBIT'
        | 'TRANSFER',
      subtitle: this._subtitle,
      isActive: this._isActive,
      metadataJson: this._metadataJson,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }
}

// ── Validation helpers (exported for the DTO layer + entity spec) ─────

export function sanitizeName(value: string): string {
  if (typeof value !== 'string') {
    throw new InvalidArgumentError(
      'name must be a string',
      'INVALID_NAME',
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidArgumentError(
      'name must be a non-empty string',
      'INVALID_NAME',
    );
  }
  if (trimmed.length > 60) {
    throw new InvalidArgumentError(
      'name must be 1..60 characters',
      'NAME_TOO_LONG',
    );
  }
  return trimmed;
}

export function sanitizeSubtitle(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new InvalidArgumentError(
      'subtitle must be a string',
      'INVALID_SUBTITLE',
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > 120) {
    throw new InvalidArgumentError(
      'subtitle must be at most 120 characters',
      'SUBTITLE_TOO_LONG',
    );
  }
  return trimmed;
}

/**
 * 4-value category guard. The enum excludes `credit` STRUCTURALLY (D6),
 * so a `category` value of `'credit'` (or any other out-of-set value)
 * is rejected here before it reaches the Prisma layer. The guard runs
 * in both `create()` and `update()` so an admin cannot sneak a bad
 * category via PATCH either.
 */
export function sanitizeCategory(value: string): PaymentMethodCategory {
  if (typeof value !== 'string') {
    throw new BusinessRuleViolationError(
      'INVALID_CATEGORY',
      'INVALID_CATEGORY',
    );
  }
  const normalized = value.toLowerCase();
  if (
    normalized !== 'cash' &&
    normalized !== 'card_credit' &&
    normalized !== 'card_debit' &&
    normalized !== 'transfer'
  ) {
    throw new BusinessRuleViolationError(
      'INVALID_CATEGORY',
      'INVALID_CATEGORY',
    );
  }
  return normalized;
}