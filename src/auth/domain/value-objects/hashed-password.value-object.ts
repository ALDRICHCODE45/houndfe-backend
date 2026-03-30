/**
 * VALUE OBJECT: HashedPassword
 *
 * Immutable representation of hashed passwords using bcrypt.
 * Handles hashing and comparison securely.
 *
 * @example
 *   const hashed = await HashedPassword.fromPlain('mypassword123')
 *   const isValid = await hashed.compare('mypassword123') // true
 */

import * as bcrypt from 'bcrypt';
import { InvalidArgumentError } from '../../../shared/domain/domain-error';

export class HashedPassword {
  private readonly hash: string;

  private constructor(hash: string) {
    this.hash = hash;
  }

  static async fromPlain(password: string): Promise<HashedPassword> {
    if (!password || password.length < 8) {
      throw new InvalidArgumentError('Password must be at least 8 characters');
    }
    const hash = await bcrypt.hash(password, 10);
    return new HashedPassword(hash);
  }

  static fromPersistence(hash: string): HashedPassword {
    return new HashedPassword(hash);
  }

  async compare(plain: string): Promise<boolean> {
    return bcrypt.compare(plain, this.hash);
  }

  get value(): string {
    return this.hash;
  }
}
