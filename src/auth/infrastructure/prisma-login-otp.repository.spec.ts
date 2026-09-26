import { Prisma, type LoginOtpChallenge } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { LoginOtpService } from '../login-otp.service';
import {
  PrismaLoginOtpRepository,
  otpBucketKey,
} from './prisma-login-otp.repository';

// A serialized, rollback-capable transaction fake exercises real repository logic.
// It does NOT prove PostgreSQL's lock scheduler or execute the SQL.
function setup() {
  let challenge: LoginOtpChallenge | null = null;
  let active = true;
  let queue = Promise.resolve();
  let buckets = new Map<string, { count: number; windowStart: Date }>();
  const query = jest.fn((sql: Prisma.Sql) => {
    if (sql.text.includes('FOR UPDATE'))
      return Promise.resolve([{ id: 'user' }]);
    const key = sql.values[0] as string;
    // SQL has literal 1 rather than a parameter in VALUES.
    const time = sql.values[1] as Date;
    const resetBefore = sql.values[2] as Date;
    const maximum = sql.values[3] as number;
    const old = buckets.get(key);
    const row =
      !old || old.windowStart <= resetBefore
        ? { count: 1, windowStart: time }
        : {
            count: Math.min(old.count + 1, maximum),
            windowStart: old.windowStart,
          };
    buckets.set(key, row);
    return Promise.resolve([row]);
  });
  const tx = {
    $queryRaw: query,
    user: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 'user',
          email: 'fake@example.test',
          isActive: active,
        }),
      ),
    },
    loginOtpChallenge: {
      findUnique: jest.fn(
        ({ where }: { where: { userId?: string; handleHash?: string } }) =>
          Promise.resolve(
            challenge &&
              (!where.handleHash || challenge.handleHash === where.handleHash)
              ? { ...challenge }
              : null,
          ),
      ),
      upsert: jest.fn(({ create }: { create: LoginOtpChallenge }) => {
        challenge = { ...create, updatedAt: new Date() };
        return Promise.resolve(challenge);
      }),
      update: jest.fn(({ data }: { data: Partial<LoginOtpChallenge> }) => {
        challenge = { ...challenge!, ...data };
        return Promise.resolve(challenge);
      }),
    },
  };
  const prisma = {
    ...tx,
    $transaction: <T>(work: (client: typeof tx) => Promise<T>): Promise<T> => {
      const run = queue.then(async () => {
        const savedChallenge = challenge && { ...challenge };
        const savedBuckets = new Map(buckets);
        try {
          return await work(tx);
        } catch (error) {
          challenge = savedChallenge;
          buckets = savedBuckets;
          throw error;
        }
      });
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
  const repo = new PrismaLoginOtpRepository(prisma as unknown as PrismaService);
  const reserve = (generation = 'g1', expectedHandleHash?: string) =>
    repo.reserve({
      userId: 'user',
      generation,
      expectedHandleHash,
      handleHash: generation.padEnd(64, '0'),
      codeMac: 'a'.repeat(64),
    });
  return {
    repo,
    reserve,
    query,
    tx,
    state: () => challenge!,
    buckets: () => buckets,
    deactivate: () => {
      active = false;
    },
  };
}

describe('PrismaLoginOtpRepository', () => {
  beforeEach(() =>
    jest.useFakeTimers({ now: new Date('2026-09-26T00:00:00Z') }),
  );
  afterEach(() => jest.useRealTimers());

  it('anchors the advertised TTL and cooldown to delayed delivery activation without resetting budgets', async () => {
    const { repo, state, buckets } = setup();
    let finishSend!: () => void;
    let startedSend!: () => void;
    const sending = new Promise<void>((resolve) => {
      startedSend = resolve;
    });
    const delivery = new Promise<void>((resolve) => {
      finishSend = resolve;
    });
    const send = jest.fn(() => {
      startedSend();
      return delivery;
    });
    const service = new LoginOtpService(
      repo,
      { send },
      new ConfigService({ JWT_SECRET: 'fake-test-secret' }),
    );
    const issuing = service.issue('user');
    await sending;
    expect(state().state).toBe('PENDING');
    const reservedAt = new Date();
    const pendingDeadline = state().expiresAt;
    const issueKey = otpBucketKey('issue', 'user');
    jest.advanceTimersByTime(120_000);
    finishSend();
    const envelope = await issuing;
    expect(state().state).toBe('ACTIVE');
    expect(state().expiresAt.getTime() - Date.now()).toBe(
      envelope.expiresIn * 1000,
    );
    expect(state().createdAt).toEqual(new Date());
    expect(state().expiresAt).not.toEqual(pendingDeadline);
    expect(buckets().get(issueKey)).toEqual({
      count: 1,
      windowStart: reservedAt,
    });
    await expect(service.resend(envelope.challengeId)).rejects.toMatchObject({
      response: { code: 'OTP_RATE_LIMITED', retryAfter: envelope.resendAfter },
    });
    expect(buckets().get(issueKey)?.count).toBe(1);
    jest.advanceTimersByTime(600_000);
    await expect(
      service.verify(envelope.challengeId, '000001'),
    ).rejects.toMatchObject({ response: { code: 'OTP_INVALID' } });
  });

  it.each(['expired', 'superseded'])(
    'rejects deferred %s delivery at the real service/repository boundary',
    async (mode) => {
      const { repo, state } = setup();
      let finishSend!: () => void;
      let startedSend!: () => void;
      const sending = new Promise<void>((resolve) => {
        startedSend = resolve;
      });
      const delivery = new Promise<void>((resolve) => {
        finishSend = resolve;
      });
      const send = jest
        .fn()
        .mockImplementationOnce(() => {
          startedSend();
          return delivery;
        })
        .mockResolvedValue(undefined);
      const service = new LoginOtpService(
        repo,
        { send },
        new ConfigService({ JWT_SECRET: 'fake-test-secret' }),
      );
      const first = service.issue('user');
      await sending;
      const originalGeneration = state().generation;
      jest.advanceTimersByTime(mode === 'expired' ? 600_000 : 60_000);
      if (mode === 'superseded') {
        await service.issue('user');
        expect(state().generation).not.toBe(originalGeneration);
        expect(state().state).toBe('ACTIVE');
      }
      const rejected = expect(first).rejects.toMatchObject({
        response: { code: 'OTP_DELIVERY_UNAVAILABLE', statusCode: 503 },
      });
      finishSend();
      await rejected;
      expect(state().state).toBe(mode === 'expired' ? 'FAILED' : 'ACTIVE');
    },
  );

  it('locks the mapped TEXT user row with parameterized SQL before mutation', async () => {
    const { reserve, query } = setup();
    await reserve();
    const sql = query.mock.calls[0][0];
    expect(sql.text).toContain(
      'SELECT "id" FROM "users" WHERE "id" = $1 FOR UPDATE',
    );
    expect(sql.text).not.toContain('uuid');
    expect(sql.values).toEqual(['user']);
  });

  it('admits exactly one of two verify consumers', async () => {
    const { repo, reserve, state } = setup();
    await reserve();
    await repo.complete('user', 'g1', true);
    const results = await Promise.all([
      repo.verify(state().handleHash, () => true),
      repo.verify(state().handleHash, () => true),
    ]);
    expect(results.filter(Boolean)).toEqual([
      { id: 'user', email: 'fake@example.test' },
    ]);
    expect(state().state).toBe('CONSUMED');
    expect(state().consumedAt).toEqual(new Date());
  });

  it('commits wrong attempts and preserves verify budget across rotation and consumption', async () => {
    const { repo, reserve, state, buckets } = setup();
    await reserve();
    await repo.complete('user', 'g1', true);
    for (let n = 0; n < 4; n++)
      await expect(
        repo.verify(state().handleHash, () => false),
      ).resolves.toBeNull();
    expect(buckets().get(otpBucketKey('verify', 'user'))?.count).toBe(4);
    jest.advanceTimersByTime(60_000);
    await reserve('g2');
    await repo.complete('user', 'g2', true);
    await expect(
      repo.verify(state().handleHash, () => true),
    ).resolves.toMatchObject({ id: 'user' });
    jest.advanceTimersByTime(60_000);
    await reserve('g3');
    await repo.complete('user', 'g3', true);
    await expect(
      repo.verify(state().handleHash, () => true),
    ).resolves.toBeNull();
    expect(buckets().get(otpBucketKey('verify', 'user'))?.count).toBe(6);
  });

  it.each(['PENDING', 'expired', 'inactive', 'unknown', 'FAILED'])(
    'rejects %s challenges',
    async (mode) => {
      const { repo, reserve, state, deactivate } = setup();
      await reserve();
      if (mode !== 'PENDING')
        await repo.complete('user', 'g1', mode !== 'FAILED');
      if (mode === 'expired') jest.advanceTimersByTime(600_000);
      if (mode === 'inactive') deactivate();
      await expect(
        repo.verify(
          mode === 'unknown' ? 'unknown' : state().handleHash,
          () => true,
        ),
      ).resolves.toBeNull();
    },
  );

  it('preserves current challenge on cooldown and exhausted issuance budget', async () => {
    const { repo, reserve, state } = setup();
    await reserve();
    await repo.complete('user', 'g1', true);
    const old = state();
    await expect(reserve('g2', old.handleHash)).resolves.toEqual({
      kind: 'limited',
      retryAfter: 60,
    });
    expect(state()).toEqual(old);
    for (const generation of ['g2', 'g3']) {
      jest.advanceTimersByTime(60_000);
      await reserve(generation);
      await repo.complete('user', generation, true);
    }
    jest.advanceTimersByTime(60_000);
    const current = state();
    await expect(reserve('g4', current.handleHash)).resolves.toEqual({
      kind: 'limited',
      retryAfter: 720,
    });
    expect(state()).toEqual(current);
  });

  it('counts failed sends and never revives old or superseded pending generations', async () => {
    const { repo, reserve, state } = setup();
    await reserve();
    await repo.complete('user', 'g1', true);
    const oldHandle = state().handleHash;
    jest.advanceTimersByTime(60_000);
    await reserve('g2', oldHandle);
    await repo.complete('user', 'g2', false);
    expect(state().state).toBe('FAILED');
    await expect(repo.verify(oldHandle, () => true)).resolves.toBeNull();
    jest.advanceTimersByTime(60_000);
    await reserve('g3');
    await expect(repo.complete('user', 'g2', true)).resolves.toBe(false);
    expect(state().state).toBe('PENDING');
    await repo.complete('user', 'g3', false);
    jest.advanceTimersByTime(60_000);
    await expect(reserve('g4')).resolves.toMatchObject({ kind: 'limited' });
  });

  it('invalidates old resend handles and rejects expired delivery completion', async () => {
    const { repo, reserve, state } = setup();
    await reserve();
    await repo.complete('user', 'g1', true);
    const old = state().handleHash;
    jest.advanceTimersByTime(60_000);
    await reserve('g2', old);
    await expect(reserve('g3', old)).resolves.toEqual({ kind: 'invalid' });
    jest.advanceTimersByTime(600_000);
    await expect(repo.complete('user', 'g2', true)).resolves.toBe(false);
    expect(state().state).toBe('FAILED');
  });

  it('atomically resets a window once and saturates parallel counters', async () => {
    const { repo, query } = setup();
    const key = otpBucketKey('source-login', 'fake-source');
    expect(
      await Promise.all(
        Array.from({ length: 4 }, () => repo.consumeRequestBudget(key, 3)),
      ),
    ).toEqual([0, 0, 0, 900]);
    jest.advanceTimersByTime(900_000);
    expect(
      await Promise.all(
        Array.from({ length: 4 }, () => repo.consumeRequestBudget(key, 3)),
      ),
    ).toEqual([0, 0, 0, 900]);
    const sql = query.mock.calls[0][0];
    expect(sql.text).toContain('ON CONFLICT ("key") DO UPDATE SET');
    expect(sql.text.match(/CASE WHEN/g)).toHaveLength(2);
    expect(sql.text).toContain('LEAST');
    expect(sql.text).not.toContain(key);
  });
});
