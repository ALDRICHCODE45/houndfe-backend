import { InvalidArgumentError } from '../../shared/domain/domain-error';
import {
  ChatbotFeedService,
  type ChatbotFeedStore,
  type FeedItemRow,
  type FeedWaiter,
  type FeedWakeupPort,
} from './chatbot-feed.service';
import { ChatbotRequestCommandError } from './chatbot-request-commands.service';

const TENANT = 't-1';
const CRED = 'cred-1';
const DELIVERY = '7f3e9d2c-1a4b-4c8e-8f6d-0a1b2c3d4e5f';
const ATTEMPT = '0b8f5c0e-6d7a-4c1e-9a52-3f1d2b6a7c10';

const row = (cursor: bigint): FeedItemRow => ({
  cursor,
  deliveryId: `d-${cursor}`,
  type: 'request.answered',
  requestId: 'r-1',
  conversationRef: 'wa:1',
  payload: { kind: 'DECISION' },
});

function setup(initial: FeedItemRow[] = []) {
  const rows = [...initial];
  const events: string[] = [];
  let clock = 0;
  let wakeNext: (() => void) | null = null;
  const assertCursorRetained = jest.fn(() => Promise.resolve());
  const readAfter = jest.fn((after: bigint, limit: number) => {
    events.push('read');
    return Promise.resolve(
      rows.filter((r) => r.cursor > after).slice(0, limit),
    );
  });
  const pendingDeferred = jest.fn(
    (): Promise<FeedItemRow[]> => Promise.resolve([]),
  );
  const recordOutcome = jest.fn((deliveryId: string) =>
    Promise.resolve({
      deliveryId,
      outcome: 'STALE' as const,
      attemptId: ATTEMPT,
      ackReceivedAt: null,
    }),
  );
  const store: ChatbotFeedStore = {
    assertCursorRetained,
    readAfter,
    pendingDeferred,
    recordOutcome,
  };
  const wakeup: FeedWakeupPort = {
    arm: jest.fn(() => {
      events.push('arm');
      let signaled = false;
      let release: (() => void) | null = null;
      const fire = () => {
        signaled = true;
        release?.();
      };
      wakeNext = fire;
      const waiter: FeedWaiter = {
        wait: (timeoutMs: number) => {
          events.push('wait');
          if (signaled) return Promise.resolve();
          return new Promise<void>((resolve) => {
            release = resolve;
            // The fake clock jumps to the timeout unless a wake-up comes first.
            setTimeout(() => {
              clock += timeoutMs;
              resolve();
            }, 1);
          });
        },
        dispose: () => events.push('dispose'),
      };
      return Promise.resolve(waiter);
    }),
  };
  const service = new ChatbotFeedService(store, wakeup, () => clock);
  return {
    service,
    mocks: { assertCursorRetained, readAfter, pendingDeferred, recordOutcome },
    rows,
    events,
    wake: () => wakeNext?.(),
  };
}

const poll = (
  service: ChatbotFeedService,
  over: Partial<Parameters<ChatbotFeedService['poll']>[0]> = {},
) =>
  service.poll({
    tenantId: TENANT,
    credentialId: CRED,
    after: 0n,
    limit: 50,
    waitSeconds: 25,
    ...over,
  });

describe('ChatbotFeedService.poll (long-poll over the feed)', () => {
  it('answers at once when items exist, with the cursor of the last one', async () => {
    const { service, events } = setup([row(5n), row(9n)]);
    const result = await poll(service);
    expect(result.items.map((i) => i.cursor)).toEqual([
      '000000000005',
      '000000000009',
    ]);
    expect(result.nextCursor).toBe('000000000009');
    expect(events).not.toContain('wait');
  });

  it('shapes an item as §3.3, with null notBefore and expiresAt', async () => {
    const { service } = setup([row(7n)]);
    const { items } = await poll(service);
    expect(items[0]).toEqual({
      cursor: '000000000007',
      deliveryId: 'd-7',
      type: 'request.answered',
      requestId: 'r-1',
      conversationRef: 'wa:1',
      payload: { kind: 'DECISION' },
      notBefore: null,
      expiresAt: null,
    });
  });

  it('honours after and limit', async () => {
    const { service } = setup([row(1n), row(2n), row(3n)]);
    const { items, nextCursor } = await poll(service, { after: 1n, limit: 1 });
    expect(items.map((i) => i.cursor)).toEqual(['000000000002']);
    expect(nextCursor).toBe('000000000002');
  });

  it('does not wait with waitSeconds=0 and echoes the cursor', async () => {
    const { service, events } = setup();
    const result = await poll(service, { after: 4n, waitSeconds: 0 });
    expect(result).toEqual({ items: [], nextCursor: '000000000004' });
    expect(events).not.toContain('wait');
  });

  it('arms the wake-up BEFORE reading, so a notification in between is not lost', async () => {
    const { service, events } = setup([row(1n)]);
    await poll(service);
    expect(events.indexOf('arm')).toBeLessThan(events.indexOf('read'));
  });

  it('waits when the feed is empty and returns the item a notification brings', async () => {
    const { service, rows, wake, events } = setup();
    const pending = poll(service);
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toContain('wait');
    rows.push(row(11n));
    wake();
    const result = await pending;
    expect(result.items.map((i) => i.cursor)).toEqual(['000000000011']);
  });

  it('returns an empty page at the deadline and disposes every waiter', async () => {
    const { service, events } = setup();
    const result = await poll(service, { waitSeconds: 1 });
    expect(result).toEqual({ items: [], nextCursor: '000000000000' });
    expect(events.filter((e) => e === 'arm').length).toBe(
      events.filter((e) => e === 'dispose').length,
    );
  });

  it('checks the cursor against retention only for a real cursor', async () => {
    const { service, mocks } = setup();
    await poll(service, { after: 0n, waitSeconds: 0 });
    expect(mocks.assertCursorRetained).not.toHaveBeenCalled();
    await poll(service, { after: 3n, waitSeconds: 0 });
    expect(mocks.assertCursorRetained).toHaveBeenCalledWith(3n);
  });

  it('propagates CURSOR_EXPIRED without reading', async () => {
    const { service, mocks } = setup();
    mocks.assertCursorRetained.mockRejectedValueOnce(
      new ChatbotRequestCommandError('CURSOR_EXPIRED', 410),
    );
    await expect(poll(service, { after: 3n })).rejects.toMatchObject({
      code: 'CURSOR_EXPIRED',
      httpStatus: 410,
    });
    expect(mocks.readAfter).not.toHaveBeenCalled();
  });

  describe('at most 2 concurrent long-polls per credential (R2)', () => {
    it('answers the third waiting poll with 429 and Retry-After', async () => {
      const { service } = setup();
      const abort = [new AbortController(), new AbortController()];
      const first = poll(service, { signal: abort[0].signal });
      const second = poll(service, { signal: abort[1].signal });
      await new Promise((resolve) => setImmediate(resolve));
      await expect(poll(service, { waitSeconds: 5 })).rejects.toMatchObject({
        code: 'RATE_LIMITED',
        httpStatus: 429,
        extra: { retryAfterSeconds: 1 },
      });
      abort.forEach((controller) => controller.abort());
      await Promise.all([first, second]);
    });

    it('counts per credential and frees the slot when a poll ends', async () => {
      const { service, wake, rows } = setup();
      const a = poll(service);
      const b = poll(service);
      await new Promise((resolve) => setImmediate(resolve));
      // Another credential is not limited by this one.
      const other = poll(service, { credentialId: 'cred-2', waitSeconds: 0 });
      await expect(other).resolves.toBeDefined();
      rows.push(row(1n));
      wake();
      await Promise.all([a, b]);
      await expect(poll(service, { waitSeconds: 0 })).resolves.toBeDefined();
      const c = poll(service);
      const d = poll(service);
      await new Promise((resolve) => setImmediate(resolve));
      rows.push(row(2n));
      wake();
      await Promise.all([c, d]);
    });

    it('does not count a poll that answers immediately', async () => {
      const { service } = setup([row(1n)]);
      const results = await Promise.all([
        poll(service),
        poll(service),
        poll(service),
      ]);
      expect(results).toHaveLength(3);
    });
  });
});

describe('ChatbotFeedService.outcome', () => {
  const body = {
    attemptId: ATTEMPT,
    outcome: 'STALE',
  };

  it('parses the body, derives the hash and records it', async () => {
    const { service, mocks } = setup();
    const ack = await service.outcome({
      deliveryId: DELIVERY,
      credentialId: CRED,
      body,
    });
    expect(ack).toMatchObject({ deliveryId: DELIVERY, outcome: 'STALE' });
    expect(mocks.recordOutcome).toHaveBeenCalledWith(
      DELIVERY,
      CRED,
      { attemptId: ATTEMPT, outcome: 'STALE' },
      expect.stringMatching(/^[0-9a-f]{64}$/),
    );
  });

  it('rejects a delivery id that is not a UUID before touching the store', async () => {
    const { service, mocks } = setup();
    await expect(
      service.outcome({ deliveryId: 'nope', credentialId: CRED, body }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(mocks.recordOutcome).not.toHaveBeenCalled();
  });

  it('rejects an invalid body (FAILED is not an outcome)', async () => {
    const { service } = setup();
    await expect(
      service.outcome({
        deliveryId: DELIVERY,
        credentialId: CRED,
        body: { attemptId: ATTEMPT, outcome: 'FAILED' },
      }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});

describe('ChatbotFeedService.pending (§4.5)', () => {
  it('requires a conversationRef', async () => {
    const { service } = setup();
    await expect(service.pending(undefined)).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
    await expect(service.pending('')).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
  });

  it('returns the deferred deliveries of the conversation, shaped as feed items', async () => {
    const { service, mocks } = setup();
    mocks.pendingDeferred.mockResolvedValueOnce([row(3n)]);
    const { items } = await service.pending('wa:1');
    expect(mocks.pendingDeferred).toHaveBeenCalledWith('wa:1', 50);
    expect(items[0]).toMatchObject({
      cursor: '000000000003',
      deliveryId: 'd-3',
    });
  });
});
