import type { Prisma } from '@prisma/client';
import { CUSTOMER_REPLY_WINDOW_MS } from '../../delivery-zones/domain/delivery-zone.policy';
import { ChatbotRequestCommandError } from '../application/chatbot-request-commands.service';
import {
  assertIntakeLimits,
  CREATION_WINDOW_MS,
  recordMerge,
  type IntakeLimits,
} from './chatbot-request-intake-writes';
import type { TenantClient } from './chatbot-request-writes';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const LIMITS: IntakeLimits = { openLimit: 20, creationsPerHour: 10 };
const minutesAgo = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000);

/** `$queryRaw` answers in order; every statement is kept for assertions. */
function fakeTx(...answers: unknown[][]) {
  const statements: Prisma.Sql[] = [];
  const queryRaw = jest.fn((sql: Prisma.Sql) => {
    statements.push(sql);
    return Promise.resolve(answers.shift() ?? []);
  });
  return {
    tx: { $queryRaw: queryRaw } as unknown as TenantClient,
    statements,
  };
}

const counts = (open: number, recent: number) => [{ open, recent }];

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ChatbotRequestCommandError) return error;
    throw error;
  }
  throw new Error('expected a ChatbotRequestCommandError');
}

describe('assertIntakeLimits', () => {
  it('passes under both limits with a single aggregate', async () => {
    const { tx, statements } = fakeTx(counts(19, 9));

    await expect(
      assertIntakeLimits(tx, 't', 'k', LIMITS, NOW),
    ).resolves.toBeUndefined();
    expect(statements).toHaveLength(1);
  });

  it('counts the hourly window from the shared window constant', async () => {
    const { tx, statements } = fakeTx(counts(0, 0));

    await assertIntakeLimits(tx, 't', 'k', LIMITS, NOW);

    expect(CREATION_WINDOW_MS).toBe(3_600_000);
    expect(statements[0].values).toContainEqual(
      new Date(NOW.getTime() - CREATION_WINDOW_MS),
    );
  });

  it('answers CUSTOMER_OPEN_LIMIT {limit, open} at the open limit', async () => {
    const { tx, statements } = fakeTx(counts(20, 0));

    const error = await rejection(
      assertIntakeLimits(tx, 't', 'k', LIMITS, NOW),
    );

    expect(error).toMatchObject({
      code: 'CUSTOMER_OPEN_LIMIT',
      httpStatus: 409,
      extra: { limit: 20, open: 20 },
    });
    expect(statements).toHaveLength(1);
  });

  it('checks the open limit before the hourly one', async () => {
    const { tx } = fakeTx(counts(25, 25));

    const error = await rejection(
      assertIntakeLimits(tx, 't', 'k', LIMITS, NOW),
    );

    expect(error.code).toBe('CUSTOMER_OPEN_LIMIT');
  });

  it('answers CUSTOMER_RATE_LIMITED with the time until the oldest creation leaves the window', async () => {
    // at the limit (10 in the window): the oldest leaving frees the slot
    const { tx, statements } = fakeTx(counts(0, 10), [
      { createdAt: minutesAgo(50) },
    ]);

    const error = await rejection(
      assertIntakeLimits(tx, 't', 'k', LIMITS, NOW),
    );

    expect(error).toMatchObject({
      code: 'CUSTOMER_RATE_LIMITED',
      httpStatus: 429,
      extra: { limit: 10, retryAfterSeconds: 10 * 60 },
    });
    // offset 0: the oldest creation inside the window
    expect(statements[1].values).toContain(0);
  });

  it('waits for as many creations to expire as the customer is over the limit', async () => {
    // 12 in the window, limit 10: three must leave before a new one fits, so
    // the wait ends with the THIRD oldest, not the oldest
    const { tx, statements } = fakeTx(counts(0, 12), [
      { createdAt: minutesAgo(40) },
    ]);

    const error = await rejection(
      assertIntakeLimits(tx, 't', 'k', LIMITS, NOW),
    );

    expect(error.extra).toMatchObject({ retryAfterSeconds: 20 * 60 });
    expect(statements[1].values).toContain(2);
  });

  it('rounds the wait up to whole seconds and never answers zero', async () => {
    const edge = new Date(NOW.getTime() - CREATION_WINDOW_MS + 400);
    const { tx } = fakeTx(counts(0, 10), [{ createdAt: edge }]);

    const error = await rejection(
      assertIntakeLimits(tx, 't', 'k', LIMITS, NOW),
    );

    expect(error.extra).toMatchObject({ retryAfterSeconds: 1 });
  });

  it('falls back to a full window when the row to wait for vanished', async () => {
    const { tx } = fakeTx(counts(0, 10), []);

    const error = await rejection(
      assertIntakeLimits(tx, 't', 'k', LIMITS, NOW),
    );

    expect(error.extra).toMatchObject({
      retryAfterSeconds: CREATION_WINDOW_MS / 1000,
    });
  });
});

describe('recordMerge', () => {
  const target = { id: 'r1', folio: 3, status: 'NEW' as const, version: 4 };
  const merged = (lastCustomerMessageAt: Date | null) => ({
    credentialId: 'cred',
    sourceRequestId: 'src',
    triggerWaMessageId: 'wamid.1',
    lastCustomerMessageAt,
  });

  function mergeTx() {
    const create = jest.fn().mockResolvedValue({});
    const executeRaw = jest.fn().mockResolvedValue(1);
    return {
      create,
      executeRaw,
      tx: {
        chatbotRequestEvent: { create },
        $executeRaw: executeRaw,
      } as unknown as TenantClient,
    };
  }

  it('appends a MERGED event at the current version and reopens the reply window', async () => {
    const { tx, create, executeRaw } = mergeTx();
    const last = minutesAgo(30);

    await recordMerge(tx, 't', target, merged(last));

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'MERGED',
        requestId: 'r1',
        version: 4,
        fromStatus: 'NEW',
        toStatus: 'NEW',
        data: { sourceRequestId: 'src', triggerWaMessageId: 'wamid.1' },
      }) as unknown,
    });
    const update = (executeRaw.mock.calls[0] as [Prisma.Sql])[0];
    // the window is the one every other creator uses, not a private copy
    expect(update.values).toContainEqual(
      new Date(last.getTime() + CUSTOMER_REPLY_WINDOW_MS),
    );
  });

  it('keeps the window when the merge carries no newer message time', async () => {
    const { tx, create, executeRaw } = mergeTx();

    await recordMerge(tx, 't', target, merged(null));

    expect(create).toHaveBeenCalledTimes(1);
    expect(executeRaw).not.toHaveBeenCalled();
  });
});
