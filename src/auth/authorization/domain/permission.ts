/**
 * Permission Registry - Central definition of all application permissions.
 *
 * CASL-compatible types and constants for authorization.
 *
 * WHY Registry: Single source of truth for permissions, ensures type safety
 * across decorators, guards, and ability checks.
 *
 * WHY MongoAbility: Same API as PureAbility but supports field-level
 * conditions for future ownership-based permissions (e.g., "update own Product").
 */

import { MongoAbility } from '@casl/ability';

/** All possible actions users can perform. */
export type AppActions = 'create' | 'read' | 'update' | 'delete' | 'manage';

/** All possible subjects (resources) in the application. */
export type AppSubjects = 'Product' | 'Order' | 'User' | 'Role' | 'all';

/** CASL ability type for the application. */
export type AppAbility = MongoAbility<[AppActions, AppSubjects]>;

/** Permission definition structure. */
export interface PermissionDefinition {
  subject: AppSubjects;
  action: AppActions;
  description: string;
}

/**
 * Complete permission registry.
 * Seeded into database on application bootstrap.
 */
export const PERMISSION_REGISTRY: readonly PermissionDefinition[] = [
  // Super admin permission
  { subject: 'all', action: 'manage', description: 'Full system access' },

  // Product permissions
  {
    subject: 'Product',
    action: 'create',
    description: 'Create new products',
  },
  { subject: 'Product', action: 'read', description: 'View products' },
  { subject: 'Product', action: 'update', description: 'Update products' },
  { subject: 'Product', action: 'delete', description: 'Delete products' },
  {
    subject: 'Product',
    action: 'manage',
    description: 'Full product management',
  },

  // Order permissions
  { subject: 'Order', action: 'create', description: 'Create new orders' },
  { subject: 'Order', action: 'read', description: 'View orders' },
  { subject: 'Order', action: 'update', description: 'Update orders' },
  { subject: 'Order', action: 'delete', description: 'Delete orders' },
  { subject: 'Order', action: 'manage', description: 'Full order management' },

  // User permissions
  { subject: 'User', action: 'create', description: 'Create new users' },
  { subject: 'User', action: 'read', description: 'View users' },
  { subject: 'User', action: 'update', description: 'Update users' },
  { subject: 'User', action: 'delete', description: 'Delete users' },
  { subject: 'User', action: 'manage', description: 'Full user management' },

  // Role permissions
  { subject: 'Role', action: 'create', description: 'Create new roles' },
  { subject: 'Role', action: 'read', description: 'View roles' },
  { subject: 'Role', action: 'update', description: 'Update roles' },
  { subject: 'Role', action: 'delete', description: 'Delete roles' },
  { subject: 'Role', action: 'manage', description: 'Full role management' },
];
