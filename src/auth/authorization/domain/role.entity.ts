/**
 * ENTITY: Role (Aggregate Root)
 *
 * Pure domain logic. No framework dependencies.
 *
 * WHY Entity: Has unique identity (id) that persists over time.
 * WHY Aggregate Root: External world references Role directly.
 *
 * BUSINESS RULES:
 * - Name must be unique (enforced at repository level)
 * - System roles (isSystem=true) cannot be deleted
 * - Permissions are immutable after creation (managed via repository)
 */

import { InvalidArgumentError } from '../../../shared/domain/domain-error';
import type { PermissionDefinition } from './permission';

export class Role {
  public readonly id: string;
  public readonly name: string;
  public readonly description: string | null;
  public readonly isSystem: boolean;
  public readonly permissions: readonly PermissionDefinition[];
  public readonly createdAt: Date;
  private _updatedAt: Date;

  private constructor(props: {
    id: string;
    name: string;
    description: string | null;
    isSystem: boolean;
    permissions: PermissionDefinition[];
    createdAt: Date;
    updatedAt: Date;
  }) {
    this.id = props.id;
    this.name = props.name;
    this.description = props.description;
    this.isSystem = props.isSystem;
    this.permissions = props.permissions;
    this.createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
  }

  /** Factory: creates a NEW role with domain validation. */
  static create(props: {
    id: string;
    name: string;
    description?: string;
    isSystem?: boolean;
    permissions?: PermissionDefinition[];
  }): Role {
    if (!props.name?.trim()) {
      throw new InvalidArgumentError('Role name is required');
    }

    const now = new Date();
    return new Role({
      id: props.id,
      name: props.name.trim(),
      description: props.description?.trim() || null,
      isSystem: props.isSystem ?? false,
      permissions: props.permissions ?? [],
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Factory: reconstructs from DB (skips validation — data is already valid). */
  static fromPersistence(data: {
    id: string;
    name: string;
    description: string | null;
    isSystem: boolean;
    permissions: PermissionDefinition[];
    createdAt: Date;
    updatedAt: Date;
  }): Role {
    return new Role({
      id: data.id,
      name: data.name,
      description: data.description,
      isSystem: data.isSystem,
      permissions: data.permissions,
      createdAt: new Date(data.createdAt),
      updatedAt: new Date(data.updatedAt),
    });
  }

  // ==================== Getters ====================

  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ==================== Serialization ====================

  toResponse() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      isSystem: this.isSystem,
      permissions: this.permissions.map((p) => ({
        subject: p.subject,
        action: p.action,
        description: p.description,
      })),
      createdAt: this.createdAt.toISOString(),
      updatedAt: this._updatedAt.toISOString(),
    };
  }

  toPersistence() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      isSystem: this.isSystem,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
