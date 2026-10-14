/**
 * cash-live harness — resume-mode offline unit checks.
 *
 * Resume mode restarts the harness against an EXISTING dataset: it never
 * seeds fresh data and never lets the production PermissionSeeder write
 * bootstrap rows. Everything here is offline and mocked:
 *   - no DB, no Nest app, no server start, no network, no .env;
 *   - the dataset peer (`./resume-dataset`, owned by the T1 worker) is
 *     consumed as a function: this spec exercises the branch with injected
 *     fakes and asserts the loader exposes the peer's real export;
 *   - the lifecycle proof uses a minimal TestingModule with a mocked
 *     PrismaService and calls `onApplicationBootstrap` explicitly.
 *
 * Any filesystem use is confined to `.tmp/cash-live-spec/<uuid>` inside
 * the project root and cleaned up by the test that created it.
 *
 * Run with:
 *   npx jest --config jest.config.js --roots test/cash-live
 */
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { PermissionSeeder } from '../../src/auth/authorization/infrastructure/permission.seeder';
import { resolveFixturePathWithinRoot } from './disposable-env';
import { writeFixtureExclusively } from './secure-fixture-write';
import { restoreExistingDataset } from './resume-dataset';
import type { SeedResult } from './seed';
import {
  NoopPermissionSeeder,
  applyResumeModuleOverrides,
  isResumeRequested,
  loadLiveDataset,
  loadResumeDatasetPeer,
  resolveResumeStartup,
} from './resume-startup';

const ROOT = '/repo/root';
const DEFAULT_RESOLVED = resolveFixturePathWithinRoot(undefined, ROOT);
const DISTINCT_FIXTURE_PATH = '.tmp/cash-live/resume.json';
const DISTINCT_RESOLVED = resolveFixturePathWithinRoot(
  DISTINCT_FIXTURE_PATH,
  ROOT,
);

const RUN_ID = 'm1abc2def3';
const SESSION_ID = '8d2c92a7-1e93-4007-992e-fb4eda18406d';

function resumeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CASH_LIVE_RESUME_RUN_ID: RUN_ID,
    CASH_LIVE_RESUME_SESSION_ID: SESSION_ID,
    CASH_LIVE_FIXTURE_PATH: DISTINCT_FIXTURE_PATH,
    ...overrides,
  };
}

describe('isResumeRequested', () => {
  it('is false when neither resume variable is present', () => {
    expect(isResumeRequested({})).toBe(false);
  });

  it('is true when only the run id is present (partial input still fails closed)', () => {
    expect(isResumeRequested({ CASH_LIVE_RESUME_RUN_ID: RUN_ID })).toBe(true);
  });

  it('is true when only the session id is present (partial input still fails closed)', () => {
    expect(
      isResumeRequested({ CASH_LIVE_RESUME_SESSION_ID: SESSION_ID }),
    ).toBe(true);
  });

  it('is true when both are present', () => {
    expect(
      isResumeRequested({
        CASH_LIVE_RESUME_RUN_ID: RUN_ID,
        CASH_LIVE_RESUME_SESSION_ID: SESSION_ID,
      }),
    ).toBe(true);
  });
});

describe('resolveResumeStartup', () => {
  it('accepts both valid ids plus an explicit distinct fixture path', () => {
    const result = resolveResumeStartup({
      env: resumeEnv(),
      fixturePath: DISTINCT_RESOLVED,
      rootDir: ROOT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config).toEqual({
        runId: RUN_ID,
        sessionId: SESSION_ID,
        fixturePath: DISTINCT_RESOLVED,
      });
    }
  });

  it('rejects a missing or empty run id', () => {
    for (const value of [undefined, '', '   ']) {
      const result = resolveResumeStartup({
        env: resumeEnv({ CASH_LIVE_RESUME_RUN_ID: value }),
        fixturePath: DISTINCT_RESOLVED,
        rootDir: ROOT,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reasons.join(' ')).toContain('CASH_LIVE_RESUME_RUN_ID');
      }
    }
  });

  it('rejects a missing or empty session id', () => {
    for (const value of [undefined, '', '   ']) {
      const result = resolveResumeStartup({
        env: resumeEnv({ CASH_LIVE_RESUME_SESSION_ID: value }),
        fixturePath: DISTINCT_RESOLVED,
        rootDir: ROOT,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reasons.join(' ')).toContain(
          'CASH_LIVE_RESUME_SESSION_ID',
        );
      }
    }
  });

  it('rejects a malformed run id', () => {
    const result = resolveResumeStartup({
      env: resumeEnv({ CASH_LIVE_RESUME_RUN_ID: 'not a run id!' }),
      fixturePath: DISTINCT_RESOLVED,
      rootDir: ROOT,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a malformed session id', () => {
    const result = resolveResumeStartup({
      env: resumeEnv({ CASH_LIVE_RESUME_SESSION_ID: 'not-a-uuid' }),
      fixturePath: DISTINCT_RESOLVED,
      rootDir: ROOT,
    });
    expect(result.ok).toBe(false);
  });

  it('accepts the shared run-id bound (1..128 lowercase alphanumerics) and rejects overflow', () => {
    const atBound = resolveResumeStartup({
      env: resumeEnv({ CASH_LIVE_RESUME_RUN_ID: 'a'.repeat(128) }),
      fixturePath: DISTINCT_RESOLVED,
      rootDir: ROOT,
    });
    const overBound = resolveResumeStartup({
      env: resumeEnv({ CASH_LIVE_RESUME_RUN_ID: 'a'.repeat(129) }),
      fixturePath: DISTINCT_RESOLVED,
      rootDir: ROOT,
    });
    expect(atBound.ok).toBe(true);
    expect(overBound.ok).toBe(false);
  });

  it('rejects when no explicit fixture path is provided', () => {
    const result = resolveResumeStartup({
      env: resumeEnv({ CASH_LIVE_FIXTURE_PATH: undefined }),
      fixturePath: DEFAULT_RESOLVED,
      rootDir: ROOT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons.join(' ')).toContain('CASH_LIVE_FIXTURE_PATH');
    }
  });

  it('rejects the default fixture path (the previous fixture is never reused)', () => {
    const result = resolveResumeStartup({
      env: resumeEnv({
        CASH_LIVE_FIXTURE_PATH: '.tmp/cash-live/fixture.json',
      }),
      fixturePath: DEFAULT_RESOLVED,
      rootDir: ROOT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons.join(' ')).toContain('CASH_LIVE_FIXTURE_PATH');
    }
  });

  it('never echoes the provided run id, session id, or path in its reasons', () => {
    const result = resolveResumeStartup({
      env: {
        CASH_LIVE_RESUME_RUN_ID: 'SECRET-RUN-ID',
        CASH_LIVE_RESUME_SESSION_ID: 'SECRET-SESSION-ID',
        CASH_LIVE_FIXTURE_PATH: '.tmp/cash-live/fixture.json',
      },
      fixturePath: DEFAULT_RESOLVED,
      rootDir: ROOT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const joined = result.reasons.join(' ');
      expect(joined).not.toContain('SECRET-RUN-ID');
      expect(joined).not.toContain('SECRET-SESSION-ID');
      expect(joined).not.toContain('SECRET');
    }
  });
});

describe('loadLiveDataset', () => {
  const prisma = {} as PrismaService;
  const seedResult = { runId: RUN_ID } as SeedResult;

  it('resume restores the existing dataset and never seeds', async () => {
    const restoreExistingDataset = jest.fn().mockResolvedValue(seedResult);
    const seedFictionalDataset = jest.fn().mockResolvedValue(seedResult);

    const result = await loadLiveDataset(
      { mode: 'resume', runId: RUN_ID, sessionId: SESSION_ID },
      { prisma, restoreExistingDataset, seedFictionalDataset },
    );

    expect(result).toBe(seedResult);
    expect(restoreExistingDataset).toHaveBeenCalledTimes(1);
    expect(restoreExistingDataset).toHaveBeenCalledWith(
      prisma,
      RUN_ID,
      SESSION_ID,
    );
    expect(seedFictionalDataset).not.toHaveBeenCalled();
  });

  it('fresh seeds the fictional dataset and never restores', async () => {
    const restoreExistingDataset = jest.fn().mockResolvedValue(seedResult);
    const seedFictionalDataset = jest.fn().mockResolvedValue(seedResult);

    const result = await loadLiveDataset(
      { mode: 'fresh', runId: RUN_ID },
      { prisma, restoreExistingDataset, seedFictionalDataset },
    );

    expect(result).toBe(seedResult);
    expect(seedFictionalDataset).toHaveBeenCalledTimes(1);
    expect(seedFictionalDataset).toHaveBeenCalledWith(prisma, RUN_ID);
    expect(restoreExistingDataset).not.toHaveBeenCalled();
  });
});

describe('applyResumeModuleOverrides (mocked lifecycle)', () => {
  function prismaWriteSpy() {
    return {
      permission: { upsert: jest.fn() },
      role: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
      rolePermission: { upsert: jest.fn() },
    };
  }

  function baseModule(prisma: unknown) {
    return Test.createTestingModule({
      providers: [PermissionSeeder, { provide: PrismaService, useValue: prisma }],
    });
  }

  it('resume replaces PermissionSeeder so bootstrap performs no write', async () => {
    const prisma = prismaWriteSpy();
    const builder = baseModule(prisma);
    applyResumeModuleOverrides(builder, { resume: true });
    const moduleRef = await builder.compile();

    const seeder = moduleRef.get(PermissionSeeder);
    expect(seeder).toBeInstanceOf(NoopPermissionSeeder);

    await seeder.onApplicationBootstrap();

    expect(prisma.permission.upsert).not.toHaveBeenCalled();
    expect(prisma.role.findFirst).not.toHaveBeenCalled();
    expect(prisma.role.create).not.toHaveBeenCalled();
    expect(prisma.role.update).not.toHaveBeenCalled();
    expect(prisma.rolePermission.upsert).not.toHaveBeenCalled();
    await moduleRef.close();
  });

  it('fresh keeps the production PermissionSeeder (no override)', async () => {
    const prisma = prismaWriteSpy();
    const builder = baseModule(prisma);
    applyResumeModuleOverrides(builder, {});
    const moduleRef = await builder.compile();

    const seeder = moduleRef.get(PermissionSeeder);
    expect(seeder).toBeInstanceOf(PermissionSeeder);
    expect(seeder).not.toBeInstanceOf(NoopPermissionSeeder);
    await moduleRef.close();
  });
});

describe('loadResumeDatasetPeer', () => {
  it('exposes the real T1 peer restoreExistingDataset export', () => {
    const peer = loadResumeDatasetPeer();
    expect(peer.restoreExistingDataset).toBe(restoreExistingDataset);
    expect(typeof peer.restoreExistingDataset).toBe('function');
  });
});

describe('resume fixture is a new file (previous fixture preserved)', () => {
  it('writes the new fixture without touching or overwriting the old one', async () => {
    const dir = path.join(
      process.cwd(),
      '.tmp',
      'cash-live-spec',
      randomUUID(),
    );
    await fsPromises.mkdir(dir, { recursive: true });
    const oldPath = path.join(dir, 'fixture.json');
    const newPath = path.join(dir, 'fixture.resume.json');
    await fsPromises.writeFile(oldPath, 'OLD-FIXTURE', { mode: 0o600 });
    try {
      await writeFixtureExclusively(newPath, 'NEW-FIXTURE');
      expect(await fsPromises.readFile(oldPath, 'utf8')).toBe('OLD-FIXTURE');
      // Overwriting the previous fixture is refused by the exclusive writer.
      await expect(
        writeFixtureExclusively(oldPath, 'NEW-FIXTURE'),
      ).rejects.toThrow();
      expect(await fsPromises.readFile(oldPath, 'utf8')).toBe('OLD-FIXTURE');
    } finally {
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  });
});
