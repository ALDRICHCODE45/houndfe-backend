/**
 * editorial-live harness — fixture building + secure 0600 write.
 *
 * EXACT owner-approved frontend contract (asserted key-by-key in
 * fixture.spec.ts):
 *
 *   { schemaVersion: 1,
 *     backend: { url, basePath: '', resourceId },
 *     frontendOrigin,
 *     tenants: [{ id, name, slug }],            // tenant A, foreign tenant
 *     product: { id, tenantId (A), name, disposable: true },
 *     actors: { 'superadmin-global', 'superadmin-tenant', 'manage-all',
 *               'editorial-only' },
 *     metadata: { owner, backendHEAD, resourceId, generatedAt, cleanup: {},
 *                 accessOnly: true, refreshTokenIssued: false,
 *                 otpIssued: false } }
 *
 * Actor: { userId, email, tenantId (= tenant.id; null for global),
 * isSuperAdmin, permissionCodes, accessToken, tenant ({id,name,slug} | null),
 * user {id,email,name,isActive,createdAt}, memberships
 * [{tenantId,tenantName,tenantSlug,roleName}], expiresAt, ttlSeconds }.
 *
 * Display rule (frontend contract): `superadmin-global` shows
 * `permissionCodes: []` and `memberships: []`. The DATABASE still holds its
 * system Super Admin role memberships (required by
 * hasGlobalEditorialAdministrator) — see ./seed.
 *
 * `accessToken` is a BEARER CREDENTIAL: written only through cash-live's
 * exclusive O_EXCL|O_NOFOLLOW 0600 writer, never logged, never overwritten.
 * No refresh token, no OTP, never the JWT secret.
 */
import type { LiveHarnessConfig } from '../cash-live/live-config';
import { readBackendHead } from '../cash-live/fixture';
import { writeFixtureExclusively } from '../cash-live/secure-fixture-write';
import type {
  EditorialActorKey,
  EditorialSeedResult,
  SeededEditorialActor,
  SeededTenant,
} from './seed';
import type { EditorialActorTokens } from './tokens';

export const EDITORIAL_FIXTURE_SCHEMA_VERSION = 1;

export interface EditorialFixtureActor {
  userId: string;
  email: string;
  /** = tenant.id; null for the global Super Admin. */
  tenantId: string | null;
  isSuperAdmin: boolean;
  permissionCodes: string[];
  accessToken: string;
  tenant: SeededTenant | null;
  user: {
    id: string;
    email: string;
    name: string;
    isActive: boolean;
    createdAt: string;
  };
  memberships: Array<{
    tenantId: string;
    tenantName: string;
    tenantSlug: string;
    roleName: string;
  }>;
  expiresAt: string;
  ttlSeconds: number;
}

export interface EditorialLiveFixture {
  schemaVersion: number;
  backend: { url: string; basePath: string; resourceId: string };
  frontendOrigin: string;
  tenants: SeededTenant[];
  product: { id: string; tenantId: string; name: string; disposable: true };
  actors: Record<EditorialActorKey, EditorialFixtureActor>;
  metadata: {
    owner: string;
    backendHEAD: string;
    resourceId: string;
    generatedAt: string;
    cleanup: {
      runId: string;
      owner: 'parent/operator';
      deletesAnything: false;
      instructions: string;
    };
    accessOnly: true;
    refreshTokenIssued: false;
    otpIssued: false;
  };
}

function toFixtureActor(
  actor: SeededEditorialActor,
  accessToken: string,
  expiresAt: Date,
  ttlSeconds: number,
): EditorialFixtureActor {
  // Frontend display rule: the global Super Admin lists no codes/memberships.
  const globalDisplay = actor.key === 'superadmin-global';
  return {
    userId: actor.userId,
    email: actor.email,
    tenantId: actor.selectedTenant?.id ?? null,
    isSuperAdmin: actor.isSuperAdmin,
    permissionCodes: globalDisplay ? [] : [...actor.permissionCodes],
    accessToken,
    tenant: actor.selectedTenant
      ? {
          id: actor.selectedTenant.id,
          name: actor.selectedTenant.name,
          slug: actor.selectedTenant.slug,
        }
      : null,
    user: {
      id: actor.userId,
      email: actor.email,
      name: actor.name,
      isActive: true,
      createdAt: actor.createdAt.toISOString(),
    },
    memberships: globalDisplay
      ? []
      : actor.memberships.map((m) => ({
          tenantId: m.tenantId,
          tenantName: m.tenantName,
          tenantSlug: m.tenantSlug,
          roleName: m.roleName,
        })),
    expiresAt: expiresAt.toISOString(),
    ttlSeconds,
  };
}

/** Assemble the fixture document (pure — no I/O besides `git rev-parse`). */
export function buildEditorialFixture(input: {
  config: LiveHarnessConfig;
  seed: EditorialSeedResult;
  backendUrl: string;
  resourceId: string;
  rootDir: string;
  tokens: EditorialActorTokens;
  expiresAt: Date;
}): EditorialLiveFixture {
  const { config, seed, tokens, expiresAt } = input;
  const ttl = config.accessTokenTtlSeconds;
  const actor = (key: EditorialActorKey) =>
    toFixtureActor(seed.actors[key], tokens[key], expiresAt, ttl);
  const tenant = (t: SeededTenant): SeededTenant => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
  });
  return {
    schemaVersion: EDITORIAL_FIXTURE_SCHEMA_VERSION,
    backend: {
      url: input.backendUrl,
      basePath: '',
      resourceId: input.resourceId,
    },
    frontendOrigin: config.frontendOrigin,
    tenants: [tenant(seed.tenants.a), tenant(seed.tenants.foreign)],
    product: {
      id: seed.product.id,
      tenantId: seed.product.tenantId,
      name: seed.product.name,
      disposable: true,
    },
    actors: {
      'superadmin-global': actor('superadmin-global'),
      'superadmin-tenant': actor('superadmin-tenant'),
      'manage-all': actor('manage-all'),
      'editorial-only': actor('editorial-only'),
    },
    metadata: {
      owner: 'gentle-ai editorial-live disposable harness',
      backendHEAD: readBackendHead(input.rootDir),
      resourceId: input.resourceId,
      generatedAt: new Date().toISOString(),
      cleanup: {
        runId: seed.runId,
        owner: 'parent/operator',
        deletesAnything: false,
        instructions: [
          'The harness never deletes anything.',
          'Stop the server (SIGTERM/SIGINT) to close Nest and Prisma;',
          'the parent/operator owns fixture removal and disposable container/database teardown.',
          'Rows of this run carry the runId in tenant/user/role/product names.',
        ].join(' '),
      },
      accessOnly: true,
      refreshTokenIssued: false,
      otpIssued: false,
    },
  };
}

/** Exclusive, no-follow, 0600-at-creation write (cash-live writer). */
export async function writeEditorialFixtureFile(
  fixturePath: string,
  fixture: EditorialLiveFixture,
): Promise<void> {
  await writeFixtureExclusively(
    fixturePath,
    `${JSON.stringify(fixture, null, 2)}\n`,
  );
}
