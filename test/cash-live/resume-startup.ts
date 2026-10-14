/**
 * cash-live harness — resume-mode startup (restart WITHOUT reseeding).
 *
 * Resume mode restarts the harness against an EXISTING, previously seeded
 * dataset so the frontend session continues with the same users,
 * permissions and session, but fresh access tokens:
 *
 *   - the dataset is READ through the T1 peer export
 *     `restoreExistingDataset(prisma, runId, sessionId)` from
 *     `./resume-dataset` (owned by the dataset worker — this module only
 *     consumes the runtime export and never reimplements it);
 *   - `seedFictionalDataset` is NEVER called in resume mode;
 *   - the production `PermissionSeeder` bootstrap writer is replaced by a
 *     no-op ONLY in resume mode (`applyResumeModuleOverrides`), so resume
 *     performs no authorization writes;
 *   - the resume fixture is written to an EXPLICIT, non-default
 *     `CASH_LIVE_FIXTURE_PATH`; the previous fixture is never reused or
 *     overwritten (the exclusive 0600 writer also refuses overwrite).
 *
 * Fail-closed rules: BOTH `CASH_LIVE_RESUME_RUN_ID` and
 * `CASH_LIVE_RESUME_SESSION_ID` must be present and well-formed, and
 * `CASH_LIVE_FIXTURE_PATH` must be set explicitly to a path different
 * from the default fixture. When ANY resume variable is present, invalid
 * input is rejected — the harness never silently falls back to a fresh
 * reseed. Rejection reasons are FIXED texts: provided values are never
 * echoed.
 *
 * This module is offline: no Nest app, no Prisma connection, no network,
 * no filesystem. It imports the T1 peer's export statically but never
 * reimplements it.
 */
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { PermissionSeeder } from '../../src/auth/authorization/infrastructure/permission.seeder';
import type { PrismaService } from '../../src/shared/prisma/prisma.service';
import { resolveFixturePathWithinRoot } from './disposable-env';
import type { SeedResult } from './seed';
// Canonical run-id charset, shared with the T1 dataset peer (single source
// of truth): reject a bad run id BEFORE module init without echoing it.
import { RUN_ID_PATTERN, restoreExistingDataset } from './resume-dataset';

/**
 * Runtime contract of the T1 dataset peer. Consumed, never implemented
 * here: `restoreExistingDataset(prisma, runId, sessionId)` reads the
 * existing dataset (and validates it) and resolves the same `SeedResult`
 * shape the fresh seeder returns.
 */
export type RestoreExistingDataset = (
  prisma: PrismaService,
  runId: string,
  sessionId: string,
) => Promise<SeedResult>;

/** Fresh-mode seeder shape; injected so the branch stays unit-testable. */
export type SeedFictionalDataset = (
  prisma: PrismaService,
  runId: string,
) => Promise<SeedResult>;

/** Peer module shape consumed from `./resume-dataset`. */
export interface ResumeDatasetPeer {
  restoreExistingDataset: RestoreExistingDataset;
}

/** Resume session id: a canonical UUID (the existing session id). */
const SESSION_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** True when EITHER resume variable is present (partial input is an error). */
export function isResumeRequested(env: NodeJS.ProcessEnv): boolean {
  return (
    env.CASH_LIVE_RESUME_RUN_ID !== undefined ||
    env.CASH_LIVE_RESUME_SESSION_ID !== undefined
  );
}

export interface ResumeStartupInput {
  env: NodeJS.ProcessEnv;
  /** Fixture path already resolved by `loadLiveHarnessConfig`. */
  fixturePath: string;
  /** Repository root (server.ts passes `process.cwd()`). */
  rootDir: string;
}

export interface ResumeStartupConfig {
  runId: string;
  sessionId: string;
  /** The NEW fixture path (always different from the default fixture). */
  fixturePath: string;
}

export type ResumeStartupResult =
  | { ok: true; config: ResumeStartupConfig }
  | { ok: false; reasons: string[] };

function nonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate the resume opt-in. Returns fixed-text reasons (never the
 * provided values) so a partial or malformed resume request fails closed
 * BEFORE any module init, token signing or listen.
 */
export function resolveResumeStartup(
  input: ResumeStartupInput,
): ResumeStartupResult {
  const reasons: string[] = [];

  const runId = input.env.CASH_LIVE_RESUME_RUN_ID;
  if (!nonEmpty(runId)) {
    reasons.push('CASH_LIVE_RESUME_RUN_ID must be set in resume mode');
  } else if (!RUN_ID_PATTERN.test(runId.trim())) {
    reasons.push('CASH_LIVE_RESUME_RUN_ID has an invalid format');
  }

  const sessionId = input.env.CASH_LIVE_RESUME_SESSION_ID;
  if (!nonEmpty(sessionId)) {
    reasons.push('CASH_LIVE_RESUME_SESSION_ID must be set in resume mode');
  } else if (!SESSION_ID_PATTERN.test(sessionId.trim())) {
    reasons.push('CASH_LIVE_RESUME_SESSION_ID has an invalid format');
  }

  const fixtureRaw = input.env.CASH_LIVE_FIXTURE_PATH;
  if (!nonEmpty(fixtureRaw)) {
    reasons.push(
      'CASH_LIVE_FIXTURE_PATH must be set explicitly in resume mode (the resume fixture is a NEW file)',
    );
  } else {
    const defaultPath = resolveFixturePathWithinRoot(undefined, input.rootDir);
    if (input.fixturePath === defaultPath) {
      reasons.push(
        'CASH_LIVE_FIXTURE_PATH must differ from the default fixture path in resume mode — the previous fixture is never reused or overwritten',
      );
    }
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }
  return {
    ok: true,
    config: {
      runId: (runId as string).trim(),
      sessionId: (sessionId as string).trim(),
      fixturePath: input.fixturePath,
    },
  };
}

/** Explicit startup request: fresh reseed vs. existing-dataset resume. */
export type LiveStartupRequest =
  | { mode: 'fresh'; runId: string }
  | { mode: 'resume'; runId: string; sessionId: string };

export interface LiveDatasetDeps {
  prisma: PrismaService;
  /** T1 peer export — called ONLY in resume mode. */
  restoreExistingDataset: RestoreExistingDataset;
  /** Fresh seeder — called ONLY in fresh mode. */
  seedFictionalDataset: SeedFictionalDataset;
}

/**
 * Resolve the dataset for a live start. This is the single branch that
 * guarantees resume NEVER seeds and fresh NEVER restores.
 */
export async function loadLiveDataset(
  request: LiveStartupRequest,
  deps: LiveDatasetDeps,
): Promise<SeedResult> {
  if (request.mode === 'resume') {
    return deps.restoreExistingDataset(
      deps.prisma,
      request.runId,
      request.sessionId,
    );
  }
  return deps.seedFictionalDataset(deps.prisma, request.runId);
}

/**
 * Resume-only no-op replacement for the production `PermissionSeeder`.
 * Its bootstrap hook performs NO writes; the stored authorization is
 * validated by the dataset peer instead.
 */
@Injectable()
export class NoopPermissionSeeder implements OnApplicationBootstrap {
  onApplicationBootstrap(): Promise<void> {
    return Promise.resolve();
  }
}

export interface LiveModuleResumeOptions {
  /**
   * Explicit resume flag. Set ONLY by `server.ts` from the validated
   * resume config — the harness never infers it from ambient env.
   */
  resume?: boolean;
}

/**
 * Apply the harness's narrow resume-only override to a module builder:
 * replace the permission-seeding bootstrap writer with a no-op. The
 * offline MAILER override is applied separately by
 * `createLiveTestingModule` and stays unchanged; auth guards, JwtStrategy
 * and Prisma are never replaced.
 */
export function applyResumeModuleOverrides(
  builder: TestingModuleBuilder,
  options: LiveModuleResumeOptions = {},
): TestingModuleBuilder {
  if (options.resume === true) {
    builder.overrideProvider(PermissionSeeder).useClass(NoopPermissionSeeder);
  }
  return builder;
}

/**
 * Expose the T1 dataset peer export consumed by the resume branch. The
 * peer signature is imported as-is and never reimplemented here.
 */
export function loadResumeDatasetPeer(): ResumeDatasetPeer {
  return { restoreExistingDataset };
}
