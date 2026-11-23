/**
 * Error codes of the customer pet routes (contract §8) with their HTTP status.
 * Bodies are code-only (`{ statusCode, error, message }`, `error === message`)
 * plus the contract's detail member at the ROOT (`currentVersion`), like the
 * backorder errors. `PET_CUSTOMER_MISMATCH` is raised by the sale-line rules
 * (T3) and lives here so every pet code has one status table.
 */
export const CUSTOMER_PET_ERROR_STATUS = {
  // 404
  PET_NOT_FOUND: 404,
  CUSTOMER_NOT_FOUND: 404,
  // 409
  PET_VERSION_CONFLICT: 409,
  // 422
  PET_ARCHIVED: 422,
  PET_NOT_ARCHIVED: 422,
  PET_LIMIT_REACHED: 422,
  PET_CUSTOMER_MISMATCH: 422,
} as const;

export type CustomerPetErrorCode = keyof typeof CUSTOMER_PET_ERROR_STATUS;

export type CustomerPetErrorDetails = Partial<{ currentVersion: number }>;

export class CustomerPetError extends Error {
  readonly status: number;

  constructor(
    readonly code: CustomerPetErrorCode,
    readonly details: CustomerPetErrorDetails = {},
  ) {
    super(code);
    this.name = 'CustomerPetError';
    this.status = CUSTOMER_PET_ERROR_STATUS[code];
  }
}

export interface PetFieldError {
  /** Request property the error is about (`birthDate`, `approxAge`, …). */
  field: string;
  /** Constraint name, like a class-validator constraint key. */
  rule: string;
  message: string;
}

/** A 400: one or more fields are invalid. Mapped to the per-field format. */
export class CustomerPetValidationError extends Error {
  constructor(readonly fields: PetFieldError[]) {
    super('CUSTOMER_PET_VALIDATION');
    this.name = 'CustomerPetValidationError';
  }
}
