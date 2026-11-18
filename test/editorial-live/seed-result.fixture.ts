/**
 * editorial-live harness — synthetic `EditorialSeedResult` for offline specs
 * (token claims, fixture schema). Fictional ids only; no DB.
 */
import type {
  EditorialSeedResult,
  SeededMembership,
  SeededTenant,
} from './seed';

export function syntheticSeed(runId = 'specrun1'): EditorialSeedResult {
  const a: SeededTenant = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: `Editorial Live Tenant A ${runId}`,
    slug: `editorial-live-a-${runId}`,
  };
  const foreign: SeededTenant = {
    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    name: `Editorial Live Foreign Tenant ${runId}`,
    slug: `editorial-live-foreign-${runId}`,
  };
  const createdAt = new Date('2026-11-18T00:00:00.000Z');
  const superMemberships: SeededMembership[] = [a, foreign].map((t) => ({
    tenantId: t.id,
    tenantName: t.name,
    tenantSlug: t.slug,
    roleId: 'role-super-admin',
    roleName: 'Super Admin',
    roleTenantId: null,
  }));
  return {
    runId,
    tenants: { a, foreign },
    product: {
      id: '22222222-2222-4222-8222-222222222222',
      tenantId: a.id,
      name: `Editorial Live Product ${runId}`,
      variantId: '33333333-3333-4333-8333-333333333333',
      foreignProductId: '44444444-4444-4444-8444-444444444444',
      foreignTenantId: foreign.id,
    },
    editorial: {
      familyCode: 'family-code',
      definitionCode: 'definition-code',
      activeOptionCode: 'active-option',
      archivedOptionCode: 'archived-option',
      unrelatedOptionCode: 'unrelated-option',
      semanticsVersion: 'editorial-production-1',
    },
    actors: {
      'superadmin-global': {
        key: 'superadmin-global',
        userId: '11111111-1111-4111-8111-111111111111',
        email: `super-admin-global.${runId}@editorial-live.test`,
        name: 'Super Admin Global (editorial-live)',
        createdAt,
        selectedTenant: null,
        isSuperAdmin: true,
        permissionCodes: ['manage:all'],
        memberships: superMemberships,
      },
      'superadmin-tenant': {
        key: 'superadmin-tenant',
        userId: '77777777-7777-4777-8777-777777777777',
        email: `super-admin-tenant.${runId}@editorial-live.test`,
        name: 'Super Admin Tenant A (editorial-live)',
        createdAt,
        selectedTenant: a,
        isSuperAdmin: true,
        permissionCodes: ['manage:all'],
        memberships: superMemberships,
      },
      'manage-all': {
        key: 'manage-all',
        userId: '55555555-5555-4555-8555-555555555555',
        email: `manager-a.${runId}@editorial-live.test`,
        name: 'Manager A (editorial-live)',
        createdAt,
        selectedTenant: a,
        isSuperAdmin: false,
        permissionCodes: ['manage:all'],
        memberships: [
          {
            tenantId: a.id,
            tenantName: a.name,
            tenantSlug: a.slug,
            roleId: 'role-manager',
            roleName: `editorial-live manager ${runId}`,
            roleTenantId: a.id,
          },
        ],
      },
      'editorial-only': {
        key: 'editorial-only',
        userId: '66666666-6666-4666-8666-666666666666',
        email: '66666666-6666-4666-8666-666666666666@example.invalid',
        name: 'Synthetic editorial user',
        createdAt,
        selectedTenant: a,
        isSuperAdmin: false,
        permissionCodes: [
          'read:ProductEditorialDraft',
          'update:ProductEditorialDraft',
        ],
        memberships: [
          {
            tenantId: a.id,
            tenantName: a.name,
            tenantSlug: a.slug,
            roleId: 'role-editorial',
            roleName: 'role-editorial',
            roleTenantId: a.id,
          },
        ],
      },
    },
    permissionsSeeded: 3,
  };
}
