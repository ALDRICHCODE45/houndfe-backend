/**
 * Slice D.2 — InngestService tests.
 *
 * `InngestService` is the NestJS-side wrapper around the Inngest client.
 * It owns:
 *
 *   1. The `Inngest` client construction (reads `INNGEST_EVENT_KEY` from
 *      `ConfigService` — required-in-prod by Joi D.4, so a missing key
 *      fails fast at boot, not at first send).
 *   2. The `send(name, data, idempotencyKey)` domain port — the dedicated
 *      low-stock outbox dispatcher (Slice F) calls this to enqueue a
 *      crossing into Inngest. The idempotency key is passed as Inngest's
 *      `id` so Inngest dedupes by it (collapses poller replays to one
 *      email — finding #5).
 *   3. The `getFunctions()` accessor that the Inngest serve handler
 *      (Slice D.3) hands to `serve({ functions })`. Empty in D; E/F
 *      populate by adding `inngest.createFunction(...)` calls.
 *
 * We mock the `inngest` module with `jest.mock` so the test exercises only
 * the wrapping code, not the SDK internals.
 *
 * Spec: design.md `Inngest + Resend Wiring` (InngestService paragraph).
 */
import type { ConfigService } from '@nestjs/config';

jest.mock('inngest', () => {
  // Test double that captures constructor options and exposes
  // jest.fn()s for `send` and `createFunction`. Real Inngest
  // behavior is irrelevant for these tests.
  const sendMock = jest.fn();
  const createFunctionMock = jest.fn((opts: unknown, handler: unknown) => ({
    opts,
    handler,
  }));

  class Inngest {
    readonly id: string;
    readonly eventKey: string | undefined;
    readonly send = sendMock;
    readonly createFunction = createFunctionMock;

    constructor(opts: { id: string; eventKey?: string }) {
      this.id = opts.id;
      this.eventKey = opts.eventKey;
    }
  }

  return {
    Inngest,
    __mocks: { sendMock, createFunctionMock },
  };
});

// Imported AFTER jest.mock so the mocked module is in place.
import { InngestService } from './inngest.service';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const inngestMock = require('inngest') as {
  Inngest: new (opts: { id: string; eventKey?: string }) => {
    id: string;
    eventKey: string | undefined;
    send: jest.Mock;
    createFunction: jest.Mock;
  };
  __mocks: { sendMock: jest.Mock; createFunctionMock: jest.Mock };
};

function makeConfigService(values: Record<string, string | undefined>): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
    getOrThrow: jest.fn((key: string) => {
      const v = values[key];
      if (v === undefined || v === null || v === '') {
        throw new Error(`Config error: missing "${key}"`);
      }
      return v;
    }),
  } as unknown as ConfigService;
}

describe('InngestService (D.2)', () => {
  beforeEach(() => {
    inngestMock.__mocks.sendMock.mockReset();
    inngestMock.__mocks.createFunctionMock.mockReset();
  });

  describe('client construction', () => {
    it('constructs an Inngest client with the configured id and eventKey', () => {
      const config = makeConfigService({
        INNGEST_EVENT_KEY: 'evt_test_123',
      });

      const svc = new InngestService(config);

      expect(svc.getClientId()).toBe('houndfe-backend');
      expect(svc.getEventKey()).toBe('evt_test_123');
    });

    it('propagates a falsy INNGEST_EVENT_KEY when missing in non-prod (dev mode uses the Inngest Dev Server)', () => {
      const config = makeConfigService({
        INNGEST_EVENT_KEY: undefined,
      });

      const svc = new InngestService(config);

      // We deliberately tolerate undefined in non-prod — the Joi schema
      // (D.4) fails the boot in production, but in dev/test/staging
      // the SDK falls back to the Inngest Dev Server.
      expect(svc.getEventKey()).toBeUndefined();
    });
  });

  describe('send(name, data, idempotencyKey)', () => {
    it('forwards name, data, and idempotencyKey to the underlying client.send', async () => {
      const config = makeConfigService({ INNGEST_EVENT_KEY: 'evt_test_123' });
      inngestMock.__mocks.sendMock.mockResolvedValue({ ids: ['evt-id-1'] });

      const svc = new InngestService(config);

      const data = { tenantId: 't1', productId: 'p1', alertEpoch: 1 };
      const result = await svc.send('stock/low.detected', data, 'idem-key-1');

      expect(inngestMock.__mocks.sendMock).toHaveBeenCalledTimes(1);
      expect(inngestMock.__mocks.sendMock).toHaveBeenCalledWith({
        name: 'stock/low.detected',
        data,
        id: 'idem-key-1',
      });
      expect(result).toEqual({ ids: ['evt-id-1'] });
    });

    it('returns whatever the underlying client.send resolves to (caller does not interpret)', async () => {
      const config = makeConfigService({ INNGEST_EVENT_KEY: 'evt_test_123' });
      inngestMock.__mocks.sendMock.mockResolvedValue({ ids: [] });

      const svc = new InngestService(config);

      const result = await svc.send('any/event', { foo: 1 }, 'k');

      expect(result).toEqual({ ids: [] });
    });

    it('propagates client.send rejections so the outbox dispatcher can mark PENDING + retry', async () => {
      const config = makeConfigService({ INNGEST_EVENT_KEY: 'evt_test_123' });
      inngestMock.__mocks.sendMock.mockRejectedValue(new Error('network down'));

      const svc = new InngestService(config);

      await expect(
        svc.send('stock/low.detected', { tenantId: 't1' }, 'k'),
      ).rejects.toThrow('network down');
    });

    it('triangulates: distinct calls preserve their own (name, data, idempotencyKey) tuple', async () => {
      const config = makeConfigService({ INNGEST_EVENT_KEY: 'evt_test_123' });
      inngestMock.__mocks.sendMock.mockResolvedValue({ ids: [] });

      const svc = new InngestService(config);

      await svc.send('event/a', { n: 1 }, 'idem-a');
      await svc.send('event/b', { n: 2 }, 'idem-b');
      await svc.send('event/c', { n: 3 }, 'idem-c');

      expect(inngestMock.__mocks.sendMock).toHaveBeenNthCalledWith(1, {
        name: 'event/a',
        data: { n: 1 },
        id: 'idem-a',
      });
      expect(inngestMock.__mocks.sendMock).toHaveBeenNthCalledWith(2, {
        name: 'event/b',
        data: { n: 2 },
        id: 'idem-b',
      });
      expect(inngestMock.__mocks.sendMock).toHaveBeenNthCalledWith(3, {
        name: 'event/c',
        data: { n: 3 },
        id: 'idem-c',
      });
    });
  });

  describe('getFunctions()', () => {
    it('returns an empty array in D (no functions registered — E/F wire them)', () => {
      const config = makeConfigService({ INNGEST_EVENT_KEY: 'evt_test_123' });
      const svc = new InngestService(config);

      expect(svc.getFunctions()).toEqual([]);
    });

    it('returns a stable defensive copy — callers cannot mutate the internal registry', () => {
      const config = makeConfigService({ INNGEST_EVENT_KEY: 'evt_test_123' });
      const svc = new InngestService(config);

      const first = svc.getFunctions();
      first.push('something-bogus' as never);

      const second = svc.getFunctions();
      expect(second).toEqual([]);
    });
  });
});