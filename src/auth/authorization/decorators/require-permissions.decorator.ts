/**
 * RequirePermissions Decorator - Marks routes with required permissions.
 *
 * Uses SetMetadata to attach permission requirements to route handlers.
 * Consumed by PermissionsGuard to enforce authorization.
 *
 * USAGE:
 *   @RequirePermissions(['create', 'Product'])
 *   @RequirePermissions(['create', 'Product'], ['read', 'Order'])
 *
 * WHY Tuple Syntax: Type safety — TypeScript ensures action and subject are valid.
 */

import { SetMetadata } from '@nestjs/common';
import type { AppActions, AppSubjects } from '../domain/permission';

/** Metadata key for permission requirements. */
export const PERMISSIONS_KEY = 'required_permissions';

/**
 * Decorator that marks a route as requiring specific permissions.
 *
 * @param permissions - Array of [action, subject] tuples
 * @returns Method decorator
 *
 * @example
 * @RequirePermissions(['create', 'Product'])
 * async createProduct() { ... }
 *
 * @example
 * @RequirePermissions(['update', 'Product'], ['read', 'Order'])
 * async updateProductWithOrderCheck() { ... }
 */
export const RequirePermissions = (
  ...permissions: Array<[AppActions, AppSubjects]>
) => SetMetadata(PERMISSIONS_KEY, permissions);
