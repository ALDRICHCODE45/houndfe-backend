/**
 * ENTITY: User (Aggregate Root)
 *
 * Pure domain logic. No framework dependencies.
 *
 * WHY Entity: Has unique identity (id) that persists over time.
 * WHY Aggregate Root: External world only references User directly.
 *
 * BUSINESS RULES:
 * - Email must be unique (enforced at repository level)
 * - Password must be hashed (never stored plain)
 * - Refresh tokens are hashed for security
 * - Inactive users cannot authenticate
 */

import { Email } from './value-objects/email.value-object';
import { HashedPassword } from './value-objects/hashed-password.value-object';
import { InvalidArgumentError } from '../../shared/domain/domain-error';

export class User {
  public readonly id: string;
  public readonly email: Email;
  public readonly hashedPassword: HashedPassword;
  private _name: string;
  private _isActive: boolean;
  private _hashedRefreshToken: string | null;
  public readonly createdAt: Date;
  private _updatedAt: Date;

  private constructor(props: {
    id: string;
    email: Email;
    hashedPassword: HashedPassword;
    name: string;
    isActive: boolean;
    hashedRefreshToken: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    this.id = props.id;
    this.email = props.email;
    this.hashedPassword = props.hashedPassword;
    this._name = props.name;
    this._isActive = props.isActive;
    this._hashedRefreshToken = props.hashedRefreshToken;
    this.createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
  }

  /** Factory: creates a NEW user with domain validation. */
  static create(props: {
    id: string;
    email: Email;
    hashedPassword: HashedPassword;
    name: string;
  }): User {
    if (!props.name?.trim()) {
      throw new InvalidArgumentError('User name is required');
    }

    const now = new Date();
    return new User({
      id: props.id,
      email: props.email,
      hashedPassword: props.hashedPassword,
      name: props.name.trim(),
      isActive: true,
      hashedRefreshToken: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Factory: reconstructs from DB (skips validation — data is already valid). */
  static fromPersistence(data: {
    id: string;
    email: string;
    hashedPassword: string;
    name: string;
    isActive: boolean;
    hashedRefreshToken: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): User {
    return new User({
      id: data.id,
      email: Email.fromPersistence(data.email),
      hashedPassword: HashedPassword.fromPersistence(data.hashedPassword),
      name: data.name,
      isActive: data.isActive,
      hashedRefreshToken: data.hashedRefreshToken,
      createdAt: new Date(data.createdAt),
      updatedAt: new Date(data.updatedAt),
    });
  }

  // ==================== Getters ====================

  get name(): string {
    return this._name;
  }

  get isActive(): boolean {
    return this._isActive;
  }

  get hashedRefreshToken(): string | null {
    return this._hashedRefreshToken;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ==================== Behavior ====================

  updateProfile(name: string): void {
    if (!name?.trim()) {
      throw new InvalidArgumentError('User name is required');
    }
    this._name = name.trim();
    this._updatedAt = new Date();
  }

  updateRefreshToken(hash: string): void {
    this._hashedRefreshToken = hash;
    this._updatedAt = new Date();
  }

  clearRefreshToken(): void {
    this._hashedRefreshToken = null;
    this._updatedAt = new Date();
  }

  activate(): void {
    this._isActive = true;
    this._updatedAt = new Date();
  }

  deactivate(): void {
    this._isActive = false;
    this._updatedAt = new Date();
  }

  // ==================== Serialization ====================

  toResponse() {
    return {
      id: this.id,
      email: this.email.value,
      name: this._name,
      isActive: this._isActive,
      createdAt: this.createdAt.toISOString(),
    };
  }

  toPersistence() {
    return {
      id: this.id,
      email: this.email.value,
      hashedPassword: this.hashedPassword.value,
      name: this._name,
      isActive: this._isActive,
      hashedRefreshToken: this._hashedRefreshToken,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
