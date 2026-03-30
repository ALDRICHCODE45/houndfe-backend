/**
 * VALUE OBJECT: Email
 *
 * Immutable representation of email addresses.
 * Validates format and normalizes to lowercase.
 *
 * @example
 *   const email = Email.create('User@Example.com')
 *   email.value // 'user@example.com'
 */

import { InvalidArgumentError } from '../../../shared/domain/domain-error';

export class Email {
  private readonly _value: string;

  private constructor(value: string) {
    this._value = value;
  }

  static create(raw: string): Email {
    if (!raw?.trim()) {
      throw new InvalidArgumentError('Email is required');
    }

    const email = raw.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(email)) {
      throw new InvalidArgumentError('Invalid email format');
    }

    return new Email(email);
  }

  static fromPersistence(value: string): Email {
    return new Email(value);
  }

  get value(): string {
    return this._value;
  }
}
