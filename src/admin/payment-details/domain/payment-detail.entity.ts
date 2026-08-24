/**
 * ENTITY: PaymentDetail (Aggregate Root) — Q1 / WU1.
 *
 * Tenant-scoped bank account reference used by the WhatsApp bot to tell the
 * customer where to transfer (CLABE / account number / beneficiary / bank).
 *
 * Pure domain logic. No framework dependencies. Mirrors the Role entity's
 * pattern: static `create()` + `fromPersistence()` + mutation methods that
 * bump `_updatedAt` and return a new instance.
 *
 * BUSINESS RULES (from `specs/payment-details/spec.md` R2 — Field
 * Validation):
 *   - `clabe` MUST be exactly 18 digits (BBVA / Banxico standard).
 *   - `accountNumber` MUST be >= 10 digits.
 *   - `bankName` and `beneficiary` MUST be non-empty after trim; the trimmed
 *     value is what gets persisted.
 *
 * LIFECYCLE (D2):
 *   - Multiple rows per tenant are allowed (multi-branch / multi-account).
 *   - Delete is logical: `deactivate()` flips `isActive = false`; the row
 *     stays in the DB for audit. There is no `reactivate` method — admins
 *     create a new row for a new active account (the deactivated row stays
 *     as historical record).
 */
import { InvalidArgumentError } from '../../../shared/domain/domain-error';

export interface PaymentDetailProps {
  id: string;
  tenantId: string;
  bankName: string;
  beneficiary: string;
  clabe: string;
  accountNumber: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePaymentDetailInput {
  id: string;
  tenantId: string;
  bankName: string;
  beneficiary: string;
  clabe: string;
  accountNumber: string;
}

export interface UpdatePaymentDetailInput {
  bankName?: string;
  beneficiary?: string;
  clabe?: string;
  accountNumber?: string;
}

export class PaymentDetail {
  private constructor(
    public readonly id: string,
    public readonly tenantId: string,
    private _bankName: string,
    private _beneficiary: string,
    private _clabe: string,
    private _accountNumber: string,
    private _isActive: boolean,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /** Factory: validate + create a NEW active `PaymentDetail` (default
   *  `isActive = true`). `tenantId` is required so the entity is always
   *  scoped at construction time — even though the prisma adapter will
   *  re-inject it, having it here keeps the entity self-contained. */
  static create(input: CreatePaymentDetailInput): PaymentDetail {
    if (!input.id || input.id.trim() === '') {
      throw new InvalidArgumentError('PaymentDetail id is required');
    }
    if (!input.tenantId || input.tenantId.trim() === '') {
      throw new InvalidArgumentError('PaymentDetail tenantId is required');
    }

    const bankName = sanitizeBankName(input.bankName);
    const beneficiary = sanitizeBeneficiary(input.beneficiary);
    const clabe = sanitizeClabe(input.clabe);
    const accountNumber = sanitizeAccountNumber(input.accountNumber);

    const now = new Date();
    return new PaymentDetail(
      input.id,
      input.tenantId,
      bankName,
      beneficiary,
      clabe,
      accountNumber,
      true,
      now,
      now,
    );
  }

  /** Factory: reconstruct from DB (skips validation — data is already valid). */
  static fromPersistence(props: PaymentDetailProps): PaymentDetail {
    return new PaymentDetail(
      props.id,
      props.tenantId,
      props.bankName,
      props.beneficiary,
      props.clabe,
      props.accountNumber,
      props.isActive,
      props.createdAt,
      props.updatedAt,
    );
  }

  // ── Getters ──────────────────────────────────────────────────────────

  get bankName(): string {
    return this._bankName;
  }

  get beneficiary(): string {
    return this._beneficiary;
  }

  get clabe(): string {
    return this._clabe;
  }

  get accountNumber(): string {
    return this._accountNumber;
  }

  get isActive(): boolean {
    return this._isActive;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ── Mutators ─────────────────────────────────────────────────────────

  /**
   * Apply a partial update. Only the supplied fields are mutated; the rest
   * stay unchanged. `updatedAt` is bumped. Bumps `_updatedAt` even when no
   * field actually changed — matches the `Role.update` precedent where
   * optimistic concurrency tracks the call as a write.
   */
  update(input: UpdatePaymentDetailInput): PaymentDetail {
    if (input.bankName !== undefined) {
      this._bankName = sanitizeBankName(input.bankName);
    }
    if (input.beneficiary !== undefined) {
      this._beneficiary = sanitizeBeneficiary(input.beneficiary);
    }
    if (input.clabe !== undefined) {
      this._clabe = sanitizeClabe(input.clabe);
    }
    if (input.accountNumber !== undefined) {
      this._accountNumber = sanitizeAccountNumber(input.accountNumber);
    }
    this._updatedAt = new Date();
    return this;
  }

  /**
   * Logical delete (D2): flips `isActive` to `false`. Idempotent — calling
   * `deactivate()` on an already-inactive row is a no-op (no extra `updatedAt`
   * bump; that would distort the "active = most recent updatedAt" selection
   * the bot endpoint relies on).
   */
  deactivate(): PaymentDetail {
    if (this._isActive) {
      this._isActive = false;
      this._updatedAt = new Date();
    }
    return this;
  }

  // ── Serialization ────────────────────────────────────────────────────

  toResponse() {
    return {
      id: this.id,
      tenantId: this.tenantId,
      bankName: this._bankName,
      beneficiary: this._beneficiary,
      clabe: this._clabe,
      accountNumber: this._accountNumber,
      isActive: this._isActive,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this._updatedAt.toISOString(),
    };
  }

  toPersistence(): {
    id: string;
    tenantId: string;
    bankName: string;
    beneficiary: string;
    clabe: string;
    accountNumber: string;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
  } {
    return {
      id: this.id,
      tenantId: this.tenantId,
      bankName: this._bankName,
      beneficiary: this._beneficiary,
      clabe: this._clabe,
      accountNumber: this._accountNumber,
      isActive: this._isActive,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }
}

// ── Validation helpers (exported for the DTO layer + entity spec) ───────

export function sanitizeBankName(value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidArgumentError(
      'bankName must be a non-empty string',
      'INVALID_BANK_NAME',
    );
  }
  return value.trim();
}

export function sanitizeBeneficiary(value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidArgumentError(
      'beneficiary must be a non-empty string',
      'INVALID_BENEFICIARY',
    );
  }
  return value.trim();
}

export function sanitizeClabe(value: string): string {
  if (typeof value !== 'string') {
    throw new InvalidArgumentError('clabe must be a string', 'INVALID_CLABE');
  }
  const trimmed = value.trim();
  if (!/^\d{18}$/.test(trimmed)) {
    throw new InvalidArgumentError(
      'clabe must be exactly 18 digits',
      'INVALID_CLABE',
    );
  }
  return trimmed;
}

export function sanitizeAccountNumber(value: string): string {
  if (typeof value !== 'string') {
    throw new InvalidArgumentError(
      'accountNumber must be a string',
      'INVALID_ACCOUNT_NUMBER',
    );
  }
  const trimmed = value.trim();
  if (!/^\d{10,}$/.test(trimmed)) {
    throw new InvalidArgumentError(
      'accountNumber must be at least 10 digits',
      'INVALID_ACCOUNT_NUMBER',
    );
  }
  return trimmed;
}
