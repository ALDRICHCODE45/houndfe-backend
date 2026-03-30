/**
 * Base class for all domain errors.
 * Domain errors represent business rule violations.
 * They are framework-agnostic (no NestJS imports).
 */

export abstract class DomainError extends Error {
  public readonly code: string;
  public readonly timestamp: Date;

  constructor(message: string, code: string) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.timestamp = new Date();
    Error.captureStackTrace(this, this.constructor);
  }
}

export class EntityNotFoundError extends DomainError {
  constructor(entityName: string, id: string) {
    super(`${entityName} with id "${id}" not found`, 'ENTITY_NOT_FOUND');
  }
}

export class BusinessRuleViolationError extends DomainError {
  constructor(message: string, code: string = 'BUSINESS_RULE_VIOLATION') {
    super(message, code);
  }
}

export class EntityAlreadyExistsError extends DomainError {
  constructor(entityName: string, identifier: string) {
    super(
      `${entityName} "${identifier}" already exists`,
      'ENTITY_ALREADY_EXISTS',
    );
  }
}

export class InvalidArgumentError extends DomainError {
  constructor(message: string, code: string = 'INVALID_ARGUMENT') {
    super(message, code);
  }
}

export class InvalidCredentialsError extends DomainError {
  constructor() {
    super('Invalid email or password', 'INVALID_CREDENTIALS');
  }
}

export class UserInactiveError extends DomainError {
  constructor() {
    super('User account is inactive', 'USER_INACTIVE');
  }
}

export class InvalidRefreshTokenError extends DomainError {
  constructor() {
    super('Invalid or expired refresh token', 'INVALID_REFRESH_TOKEN');
  }
}

export class InsufficientPermissionsError extends DomainError {
  constructor() {
    super('Insufficient permissions', 'INSUFFICIENT_PERMISSIONS');
  }
}

export class SystemRoleProtectedError extends DomainError {
  constructor(roleName: string) {
    super(
      `System role "${roleName}" cannot be deleted`,
      'SYSTEM_ROLE_PROTECTED',
    );
  }
}
