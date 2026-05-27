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
export type AppSubjects =
  | 'Product'
  | 'Order'
  | 'Sale'
  | 'User'
  | 'Role'
  | 'Tenant'
  | 'Brand'
  | 'Category'
  | 'GlobalPriceList'
  | 'TenantMembership'
  | 'Promotion'
  | 'Customer'
  | 'SaleComment'
  | 'File'
  | 'Employee'
  | 'EmployeeDocument'
  | 'EmployeeSalary'
  | 'all';

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

  // Tenant permissions
  { subject: 'Tenant', action: 'create', description: 'Create new tenants' },
  { subject: 'Tenant', action: 'read', description: 'View tenants' },
  { subject: 'Tenant', action: 'update', description: 'Update tenants' },
  { subject: 'Tenant', action: 'delete', description: 'Deactivate tenants' },

  // Promotion permissions
  {
    subject: 'Promotion',
    action: 'create',
    description: 'Create new promotions',
  },
  { subject: 'Promotion', action: 'read', description: 'View promotions' },
  {
    subject: 'Promotion',
    action: 'update',
    description: 'Update promotions',
  },
  {
    subject: 'Promotion',
    action: 'delete',
    description: 'Delete promotions',
  },
  {
    subject: 'Promotion',
    action: 'manage',
    description: 'Full promotion management',
  },

  // Customer permissions
  {
    subject: 'Customer',
    action: 'create',
    description: 'Create new customers',
  },
  { subject: 'Customer', action: 'read', description: 'View customers' },
  {
    subject: 'Customer',
    action: 'update',
    description: 'Update customers',
  },
  {
    subject: 'Customer',
    action: 'delete',
    description: 'Delete customers',
  },
  {
    subject: 'Customer',
    action: 'manage',
    description: 'Full customer management',
  },

  // Sale permissions
  { subject: 'Sale', action: 'create', description: 'Create new sales' },
  { subject: 'Sale', action: 'read', description: 'View sales' },
  { subject: 'Sale', action: 'update', description: 'Update sales' },
  { subject: 'Sale', action: 'delete', description: 'Delete sales' },
  { subject: 'Sale', action: 'manage', description: 'Full sale management' },

  // SaleComment permissions
  {
    subject: 'SaleComment',
    action: 'create',
    description: 'Create sale comments',
  },
  { subject: 'SaleComment', action: 'read', description: 'View sale comments' },
  {
    subject: 'SaleComment',
    action: 'update',
    description: 'Update own sale comments',
  },
  {
    subject: 'SaleComment',
    action: 'delete',
    description: 'Delete own sale comments',
  },
  {
    subject: 'SaleComment',
    action: 'manage',
    description: 'Full sale comment management',
  },

  // Brand permissions
  { subject: 'Brand', action: 'create', description: 'Create new brands' },
  { subject: 'Brand', action: 'read', description: 'View brands' },
  { subject: 'Brand', action: 'update', description: 'Update brands' },
  { subject: 'Brand', action: 'delete', description: 'Delete brands' },
  {
    subject: 'Brand',
    action: 'manage',
    description: 'Full brand management',
  },

  // Category permissions
  {
    subject: 'Category',
    action: 'create',
    description: 'Create new categories',
  },
  { subject: 'Category', action: 'read', description: 'View categories' },
  {
    subject: 'Category',
    action: 'update',
    description: 'Update categories',
  },
  {
    subject: 'Category',
    action: 'delete',
    description: 'Delete categories',
  },
  {
    subject: 'Category',
    action: 'manage',
    description: 'Full category management',
  },

  // GlobalPriceList permissions
  {
    subject: 'GlobalPriceList',
    action: 'create',
    description: 'Create new global price lists',
  },
  {
    subject: 'GlobalPriceList',
    action: 'read',
    description: 'View global price lists',
  },
  {
    subject: 'GlobalPriceList',
    action: 'update',
    description: 'Update global price lists',
  },
  {
    subject: 'GlobalPriceList',
    action: 'delete',
    description: 'Delete global price lists',
  },
  {
    subject: 'GlobalPriceList',
    action: 'manage',
    description: 'Full global price list management',
  },

  // TenantMembership permissions
  {
    subject: 'TenantMembership',
    action: 'create',
    description: 'Create new tenant memberships',
  },
  {
    subject: 'TenantMembership',
    action: 'read',
    description: 'View tenant memberships',
  },
  {
    subject: 'TenantMembership',
    action: 'update',
    description: 'Update tenant memberships',
  },
  {
    subject: 'TenantMembership',
    action: 'delete',
    description: 'Delete tenant memberships',
  },
  {
    subject: 'TenantMembership',
    action: 'manage',
    description: 'Full tenant membership management',
  },

  // File permissions
  { subject: 'File', action: 'create', description: 'Upload files' },
  { subject: 'File', action: 'read', description: 'View files' },
  { subject: 'File', action: 'delete', description: 'Delete files' },
  { subject: 'File', action: 'manage', description: 'Full file management' },

  // Employee permissions
  {
    subject: 'Employee',
    action: 'create',
    description: 'Create employees',
  },
  { subject: 'Employee', action: 'read', description: 'View employee profiles' },
  {
    subject: 'Employee',
    action: 'update',
    description: 'Update employee data',
  },
  {
    subject: 'Employee',
    action: 'delete',
    description: 'Delete employees',
  },
  {
    subject: 'Employee',
    action: 'manage',
    description: 'Full employee management',
  },

  // EmployeeSalary permissions (sensitive — Tier 2 financial)
  {
    subject: 'EmployeeSalary',
    action: 'create',
    description: 'Add salary changes',
  },
  {
    subject: 'EmployeeSalary',
    action: 'read',
    description: 'View salary data and history',
  },
  {
    subject: 'EmployeeSalary',
    action: 'manage',
    description: 'Full salary management',
  },

  // EmployeeDocument permissions
  {
    subject: 'EmployeeDocument',
    action: 'create',
    description: 'Upload employee documents',
  },
  {
    subject: 'EmployeeDocument',
    action: 'read',
    description: 'View employee documents',
  },
  {
    subject: 'EmployeeDocument',
    action: 'delete',
    description: 'Delete employee documents',
  },
  {
    subject: 'EmployeeDocument',
    action: 'manage',
    description: 'Full employee document management',
  },
];
