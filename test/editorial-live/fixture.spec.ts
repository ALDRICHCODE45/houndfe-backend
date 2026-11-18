/**
 * editorial-live harness — fixture shape (frontend contract) + secure write.
 *
 * The shape is the owner-approved frontend contract, asserted EXACTLY (key
 * sets included). The write reuses cash-live's exclusive 0600 writer; this
 * spec writes only under its own `.tmp/editorial-live-spec/<uuid>` tree
 * inside the project root and removes exactly that tree afterwards.
 */
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  EDITORIAL_FIXTURE_SCHEMA_VERSION,
  buildEditorialFixture,
  writeEditorialFixtureFile,
} from './fixture';
import { EDITORIAL_ACTOR_KEYS, type EditorialActorKey } from './seed';
import { syntheticSeed } from './seed-result.fixture';

const SPEC_DIR = path.join(
  process.cwd(),
  '.tmp',
  'editorial-live-spec',
  randomUUID(),
);
const jwtSecret = 'never-in-fixture-secret-0123456789abcdefgh';
const ACTOR_KEYS = [
  'accessToken',
  'email',
  'expiresAt',
  'isSuperAdmin',
  'memberships',
  'permissionCodes',
  'tenant',
  'tenantId',
  'ttlSeconds',
  'user',
  'userId',
];

function build() {
  const seed = syntheticSeed('run9');
  const tokens = Object.fromEntries(
    EDITORIAL_ACTOR_KEYS.map((key) => [key, `token-for-${key}`]),
  ) as Record<EditorialActorKey, string>;
  return {
    seed,
    fixture: buildEditorialFixture({
      config: {
        frontendOrigin: 'http://127.0.0.1:4191',
        fixturePath: path.join(SPEC_DIR, 'fixture.json'),
        jwtSecret,
        jwtSecretFromEnv: false,
        accessTokenTtlSeconds: 7200,
        accessTokenExpiresIn: '7200s',
      },
      seed,
      backendUrl: 'http://127.0.0.1:40123',
      resourceId: 'R',
      rootDir: process.cwd(),
      tokens,
      expiresAt: new Date('2026-11-18T02:00:00.000Z'),
    }),
  };
}

afterAll(async () => {
  await fsPromises.rm(SPEC_DIR, { recursive: true, force: true });
});

describe('editorial-live fixture (frontend contract)', () => {
  it('has exactly the agreed top-level shape', () => {
    const { fixture, seed } = build();
    expect(EDITORIAL_FIXTURE_SCHEMA_VERSION).toBe(1);
    expect(Object.keys(fixture).sort()).toEqual(
      [
        'actors',
        'backend',
        'frontendOrigin',
        'metadata',
        'product',
        'schemaVersion',
        'tenants',
      ].sort(),
    );
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.backend).toEqual({
      url: 'http://127.0.0.1:40123',
      basePath: '',
      resourceId: 'R',
    });
    expect(fixture.frontendOrigin).toBe('http://127.0.0.1:4191');
    expect(fixture.tenants).toEqual([seed.tenants.a, seed.tenants.foreign]);
    for (const tenant of fixture.tenants)
      expect(Object.keys(tenant).sort()).toEqual(['id', 'name', 'slug']);
    expect(fixture.product).toEqual({
      id: seed.product.id,
      tenantId: seed.tenants.a.id,
      name: seed.product.name,
      disposable: true,
    });
    expect(Object.keys(fixture.actors)).toEqual([
      'superadmin-global',
      'superadmin-tenant',
      'manage-all',
      'editorial-only',
    ]);
  });

  it('metadata: exact keys, cleanup object, access-only flags', () => {
    const { fixture } = build();
    expect(Object.keys(fixture.metadata).sort()).toEqual(
      [
        'accessOnly',
        'backendHEAD',
        'cleanup',
        'generatedAt',
        'otpIssued',
        'owner',
        'refreshTokenIssued',
        'resourceId',
      ].sort(),
    );
    expect(fixture.metadata).toMatchObject({
      resourceId: 'R',
      accessOnly: true,
      refreshTokenIssued: false,
      otpIssued: false,
    });
    expect(typeof fixture.metadata.owner).toBe('string');
    expect(typeof fixture.metadata.backendHEAD).toBe('string');
    expect(Number.isNaN(Date.parse(fixture.metadata.generatedAt))).toBe(false);
    expect(fixture.metadata.cleanup).toEqual({
      runId: 'run9',
      owner: 'parent/operator',
      deletesAnything: false,
      instructions: expect.any(String) as string,
    });
  });

  it('every actor has exactly the agreed fields, distinct ids and tokens, no refresh token', () => {
    const { fixture } = build();
    const actors = Object.values(fixture.actors);
    for (const actor of actors) {
      expect(Object.keys(actor).sort()).toEqual(ACTOR_KEYS);
      expect(Object.keys(actor.user).sort()).toEqual(
        ['createdAt', 'email', 'id', 'isActive', 'name'].sort(),
      );
      expect(actor.user.id).toBe(actor.userId);
      expect(actor.user.email).toBe(actor.email);
      expect(actor.user.isActive).toBe(true);
      expect(actor.tenantId).toBe(actor.tenant?.id ?? null);
      if (actor.tenant)
        expect(Object.keys(actor.tenant).sort()).toEqual([
          'id',
          'name',
          'slug',
        ]);
      for (const m of actor.memberships)
        expect(Object.keys(m).sort()).toEqual(
          ['roleName', 'tenantId', 'tenantName', 'tenantSlug'].sort(),
        );
      expect(actor.expiresAt).toBe('2026-11-18T02:00:00.000Z');
      expect(actor.ttlSeconds).toBe(7200);
      expect(actor).not.toHaveProperty('refreshToken');
    }
    expect(new Set(actors.map((a) => a.userId)).size).toBe(4);
    expect(new Set(actors.map((a) => a.accessToken)).size).toBe(4);
  });

  it('per-actor contract values', () => {
    const { fixture, seed } = build();
    const a = seed.tenants.a;
    expect(fixture.actors['superadmin-global']).toMatchObject({
      isSuperAdmin: true,
      tenantId: null,
      tenant: null,
      permissionCodes: [],
      memberships: [],
      accessToken: 'token-for-superadmin-global',
    });
    expect(fixture.actors['superadmin-tenant']).toMatchObject({
      isSuperAdmin: true,
      tenantId: a.id,
      tenant: a,
    });
    expect(fixture.actors['manage-all']).toMatchObject({
      isSuperAdmin: false,
      tenantId: a.id,
      tenant: a,
      permissionCodes: ['manage:all'],
    });
    expect(fixture.actors['editorial-only']).toMatchObject({
      isSuperAdmin: false,
      tenantId: a.id,
      tenant: a,
      permissionCodes: [
        'read:ProductEditorialDraft',
        'update:ProductEditorialDraft',
      ],
    });
    expect(fixture.actors['editorial-only'].permissionCodes).not.toContain(
      'manage:all',
    );
    for (const key of ['manage-all', 'editorial-only'] as const)
      expect(fixture.actors[key].memberships.map((m) => m.tenantId)).toContain(
        fixture.product.tenantId,
      );
  });

  it('never contains the JWT secret', () => {
    expect(JSON.stringify(build().fixture)).not.toContain(jwtSecret);
  });

  it('writes 0600 exclusively and refuses to overwrite', async () => {
    const { fixture } = build();
    const target = path.join(SPEC_DIR, 'fixture.json');
    await writeEditorialFixtureFile(target, fixture);
    const stat = await fsPromises.stat(target);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fsPromises.readFile(target, 'utf8'))).toEqual(
      JSON.parse(JSON.stringify(fixture)),
    );
    await expect(writeEditorialFixtureFile(target, fixture)).rejects.toThrow(
      'refusing to overwrite',
    );
  });
});
