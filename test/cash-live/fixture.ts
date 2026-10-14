/**
 * cash-live harness — fixture building and secure 0600 write.
 *
 * The fixture is the frontend-agreed contract for the joint live test.
 * The `accessToken` is a BEARER CREDENTIAL: it is short-lived (TTL-bound,
 * `expiresAt` included) and no refresh token or OTP is ever issued, but it
 * grants real API access while valid — it is written 0600-only, never
 * logged, and the file is never overwritten.
 *
 * Actor shape (frontend agreed schema):
 *   - flat identity fields: `userId`, `tenantId`, `email`, `permissionCodes`,
 *     `accessToken`;
 *   - nested summaries: `user {id,email,name,isActive,createdAt}`,
 *     `tenant {id,name,slug}`, `memberships` (tenant summaries);
 *   - session fields: `functionalRole` (`cashier` | `verifier` | `foreign`),
 *     `expiresAt`, `ttlSeconds`.
 *
 * Metadata carries ownership/traceability (`owner`, `backendHEAD`,
 * `resourceId`, `readiness`, `cleanup`) with zero secret material.
 */
import { execFileSync } from 'node:child_process';
import type { LiveHarnessConfig } from './live-config';
import type { SeedResult, SeededUser, FunctionalRole } from './seed';
import { writeFixtureExclusively } from './secure-fixture-write';

export const FIXTURE_SCHEMA_VERSION = 1;

export interface FixtureActor {
  userId: string;
  tenantId: string;
  email: string;
  permissionCodes: string[];
  accessToken: string;
  functionalRole: FunctionalRole;
  user: {
    id: string;
    email: string;
    name: string;
    isActive: boolean;
    createdAt: string;
  };
  tenant: { id: string; name: string; slug: string };
  memberships: Array<{
    tenantId: string;
    tenantName: string;
    tenantSlug: string;
    roleName: string;
  }>;
  expiresAt: string;
  ttlSeconds: number;
}

export interface CashLiveFixture {
  schemaVersion: number;
  backend: { url: string; basePath: string; resourceId: string };
  frontendOrigin: string;
  tenants: Array<{ id: string; name: string; slug: string }>;
  actors: {
    cashier: FixtureActor;
    verifier: FixtureActor;
    foreign: FixtureActor;
  };
  metadata: {
    owner: string;
    backendHEAD: string;
    resourceId: string;
    generatedAt: string;
    readiness: Record<string, unknown>;
    cleanup: string;
    accessOnly: boolean;
    refreshTokenIssued: false;
    otpIssued: false;
  };
}

/** Read the backend HEAD commit for traceability (never fails the run). */
export function readBackendHead(rootDir: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: rootDir,
      encoding: 'utf8',
      timeout: 5_000,
    }).trim();
  } catch {
    return 'unknown';
  }
}

function toFixtureActor(
  seeded: SeededUser,
  seed: SeedResult,
  accessToken: string,
  expiresAt: Date,
  ttlSeconds: number,
): FixtureActor {
  const tenant = seed.tenants.find((t) => t.id === seeded.tenantId) as {
    id: string;
    name: string;
    slug: string;
  };
  const actorUser = {
    id: seeded.id,
    email: seeded.email,
    name: seeded.name,
    isActive: true,
    createdAt: seeded.createdAt.toISOString(),
  };
  return {
    userId: seeded.id,
    tenantId: seeded.tenantId,
    email: seeded.email,
    permissionCodes: [...seeded.permissionCodes],
    accessToken,
    functionalRole: seeded.functionalRole,
    user: actorUser,
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    memberships: [
      {
        tenantId: tenant.id,
        tenantName: tenant.name,
        tenantSlug: tenant.slug,
        roleName: `cash-live ${seeded.functionalRole} ${seed.runId}`,
      },
    ],
    expiresAt: expiresAt.toISOString(),
    ttlSeconds,
  };
}

/** Assemble the fixture document (pure — no I/O). */
export function buildFixture(input: {
  config: LiveHarnessConfig;
  seed: SeedResult;
  backendUrl: string;
  resourceId: string;
  rootDir: string;
  tokens: { cashier: string; verifier: string; foreign: string };
  expiresAt: Date;
  permissionsSeeded: number;
}): CashLiveFixture {
  const { config, seed } = input;
  const ttlSeconds = config.accessTokenTtlSeconds;
  return {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    backend: {
      url: input.backendUrl,
      basePath: '',
      resourceId: input.resourceId,
    },
    frontendOrigin: config.frontendOrigin,
    tenants: seed.tenants.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
    })),
    actors: {
      cashier: toFixtureActor(
        seed.users.cashier,
        seed,
        input.tokens.cashier,
        input.expiresAt,
        ttlSeconds,
      ),
      verifier: toFixtureActor(
        seed.users.verifier,
        seed,
        input.tokens.verifier,
        input.expiresAt,
        ttlSeconds,
      ),
      foreign: toFixtureActor(
        seed.users.foreign,
        seed,
        input.tokens.foreign,
        input.expiresAt,
        ttlSeconds,
      ),
    },
    metadata: {
      owner: 'gentle-ai cash-live disposable harness',
      backendHEAD: readBackendHead(input.rootDir),
      resourceId: input.resourceId,
      generatedAt: new Date().toISOString(),
      readiness: {
        seeded: true,
        tenants: seed.tenants.length,
        users: Object.keys(seed.users).length,
        permissionsSeeded: input.permissionsSeeded,
        accessTokensIssued: Object.keys(input.tokens).length,
      },
      cleanup: [
        'The harness never deletes anything.',
        'Stop the server (SIGTERM/SIGINT) to close Nest and Prisma;',
        'the parent/operator owns fixture removal and disposable container/database teardown.',
      ].join(' '),
      accessOnly: true,
      refreshTokenIssued: false,
      otpIssued: false,
    },
  };
}

/**
 * Write the fixture to the EXACT validated path via an exclusive, no-follow
 * handle with mode 0600 set at creation:
 *   - no truncation/overwrite of a pre-existing file;
 *   - no symlink parents and no symlink target;
 *   - NO chmod on the path after the token bytes exist.
 * The path must already have been validated by
 * `resolveFixturePathWithinRoot` (repository-contained, no traversal).
 */
export async function writeFixtureFile(
  fixturePath: string,
  fixture: CashLiveFixture,
): Promise<void> {
  const body = `${JSON.stringify(fixture, null, 2)}\n`;
  await writeFixtureExclusively(fixturePath, body);
}
