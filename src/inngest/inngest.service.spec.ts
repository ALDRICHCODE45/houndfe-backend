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
 *   4. The `registerFunctions(...)` duplicate-id guard (pca-5c): it
 *      resolves ids from the real Inngest v4 surface (`id()` method /
 *      `opts.id`), rejects duplicates atomically without mutating the
 *      registry, and fails closed on entries whose id cannot be resolved.
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
    readonly isDev: boolean | undefined;
    readonly send = sendMock;
    readonly createFunction = createFunctionMock;

    constructor(opts: { id: string; eventKey?: string; isDev?: boolean }) {
      this.id = opts.id;
      this.eventKey = opts.eventKey;
      this.isDev = opts.isDev;
    }
  }

  return {
    Inngest,
    __mocks: { sendMock, createFunctionMock },
  };
});

// Imported AFTER jest.mock so the mocked module is in place.
import { InngestService } from './inngest.service';

// `jest.requireMock` returns the SAME registered mock object as a bare
// `require('inngest')` under `jest.mock` above, without the
// `@typescript-eslint/no-require-imports` violation. The explicit generic
// keeps the module's own (unmocked) type from narrowing the assertion.
const inngestMock = jest.requireMock<Record<string, unknown>>('inngest') as {
  Inngest: new (opts: { id: string; eventKey?: string; isDev?: boolean }) => {
    id: string;
    eventKey: string | undefined;
    isDev: boolean | undefined;
    send: jest.Mock;
    createFunction: jest.Mock;
  };
  __mocks: { sendMock: jest.Mock; createFunctionMock: jest.Mock };
};

function makeConfigService(
  values: Record<string, string | undefined>,
): ConfigService {
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

// ─── pca-5c — REAL v4 SDK function shape ──────────────────────────────
// The duplicate-id guard exists to protect the functions that are ACTUALLY
// registered at boot. Those come from `InngestService.getClient()` and the
// real Inngest v4 SDK, whose `InngestFunction` exposes the id as a
// prototype METHOD `id()` plus a raw `opts.id` — there is no string `id`
// property and no `config` property. The previous guard only read
// `id`-as-string / `config.id`, so every real function resolved to `null`
// and duplicate detection was a no-op.
//
// These helpers build the genuine SDK object through `jest.requireActual`
// (NOT the local test double above), because a hand-rolled fake would let
// the guard regress to a shape the SDK never produces.
interface RealV4ClientLike {
  createFunction: (
    opts: { id: string; triggers: { event: string }[] },
    handler: () => Promise<void>,
  ) => unknown;
}

function makeRealV4Function(id: string): unknown {
  const actual = jest.requireActual<{
    Inngest: new (opts: { id: string }) => RealV4ClientLike;
  }>('inngest');
  const client = new actual.Inngest({ id: 'pca-5c-registry-probe' });
  return client.createFunction(
    { id, triggers: [{ event: 'pca-5c/probe' }] },
    () => Promise.resolve(),
  );
}

describe('InngestService (D.2)', () => {
  // Track constructor calls so we can assert the options handed to the
  // SDK — fail-closed tests below pin isDev:false regardless of INNGEST_DEV.
  type CapturedOpts = {
    id: string;
    eventKey?: string;
    isDev?: boolean;
  };
  const capturedConstructors: CapturedOpts[] = [];
  let OriginalInngest: typeof inngestMock.Inngest;

  beforeAll(() => {
    OriginalInngest = inngestMock.Inngest;
  });

  beforeEach(() => {
    inngestMock.__mocks.sendMock.mockReset();
    inngestMock.__mocks.createFunctionMock.mockReset();
    capturedConstructors.length = 0;
    // Wrap the mocked constructor so we can capture every call's options.
    const Wrapped = jest.fn((opts: CapturedOpts) => {
      capturedConstructors.push({ ...opts });
      return new OriginalInngest(opts);
    });
    Object.setPrototypeOf(Wrapped, OriginalInngest);
    (inngestMock as unknown as { Inngest: unknown }).Inngest =
      Wrapped as unknown as typeof OriginalInngest;
  });

  afterEach(() => {
    // Restore the original mocked constructor so other specs that share
    // the module-level mock don't see our wrapper.
    (inngestMock as unknown as { Inngest: unknown }).Inngest = OriginalInngest;
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

  // ─── pca-5c — duplicate-id guard against the REAL v4 function shape ──
  // RED before the fix: every real v4 function resolved to `null`, so both
  // the same-batch duplicate and the across-call duplicate were accepted
  // while mutating the registry.
  describe('registerFunctions() duplicate-id guard (pca-5c)', () => {
    it('rejects two REAL v4 SDK functions sharing an id in one batch and leaves the registry untouched', () => {
      const config = makeConfigService({ INNGEST_EVENT_KEY: 'evt_test_123' });
      const svc = new InngestService(config);
      const first = makeRealV4Function('promotion-near-capacity-email');
      const second = makeRealV4Function('promotion-near-capacity-email');

      // Sanity: prove these are the real SDK objects whose id is only
      // reachable through `id()` / `opts.id` — the exact mismatch pca-5c
      // closes. If this assertion ever fails, the fixture stopped being
      // representative and the regression test would be vacuous.
      expect(typeof (first as { id: unknown }).id).toBe('function');
      expect((first as { opts: { id: string } }).opts.id).toBe(
        'promotion-near-capacity-email',
      );
      expect((first as { config?: unknown }).config).toBeUndefined();

      expect(() => svc.registerFunctions([first, second])).toThrow(
        'duplicate function id "promotion-near-capacity-email"',
      );
      expect(svc.getFunctions()).toEqual([]);
    });

    it('rejects a REAL v4 function whose id was registered by an earlier call, without mutating the registry', () => {
      const config = makeConfigService({ INNGEST_EVENT_KEY: 'evt_test_123' });
      const svc = new InngestService(config);
      svc.registerFunctions([makeRealV4Function('promotion-expiring-email')]);
      const afterFirstCall = svc.getFunctions();
      expect(afterFirstCall).toHaveLength(1);

      expect(() =>
        svc.registerFunctions([makeRealV4Function('promotion-expiring-email')]),
      ).toThrow('duplicate function id "promotion-expiring-email"');

      const afterRejection = svc.getFunctions();
      expect(afterRejection).toHaveLength(1);
      expect(afterRejection[0]).toBe(afterFirstCall[0]);
    });

    it('accepts distinct REAL v4 ids across batches and calls (no false positives)', () => {
      const config = makeConfigService({ INNGEST_EVENT_KEY: 'evt_test_123' });
      const svc = new InngestService(config);

      svc.registerFunctions([
        makeRealV4Function('promotion-near-capacity-email'),
        makeRealV4Function('promotion-expiring-email'),
      ]);
      svc.registerFunctions([makeRealV4Function('stock-low-detected-email')]);

      const registered = svc.getFunctions();
      expect(registered).toHaveLength(3);
      expect(
        registered.map((fn) => (fn as { opts: { id: string } }).opts.id),
      ).toEqual([
        'promotion-near-capacity-email',
        'promotion-expiring-email',
        'stock-low-detected-email',
      ]);
    });

    it('is atomic: a rejected batch registers none of its earlier valid entries', () => {
      const config = makeConfigService({ INNGEST_EVENT_KEY: 'evt_test_123' });
      const svc = new InngestService(config);
      svc.registerFunctions([makeRealV4Function('already-registered')]);

      expect(() =>
        svc.registerFunctions([
          makeRealV4Function('brand-new-function'),
          makeRealV4Function('already-registered'),
        ]),
      ).toThrow('duplicate function id "already-registered"');

      const registered = svc.getFunctions();
      expect(registered).toHaveLength(1);
      expect((registered[0] as { opts: { id: string } }).opts.id).toBe(
        'already-registered',
      );
    });

    it('keeps supporting the legacy fake shapes (string id / config.id / opts.id) and still detects their duplicates', () => {
      const config = makeConfigService({ INNGEST_EVENT_KEY: 'evt_test_123' });
      const svc = new InngestService(config);

      svc.registerFunctions([
        { id: 'fake-string-id' },
        { config: { id: 'fake-config-id' } },
        { opts: { id: 'fake-opts-id' } },
      ]);
      expect(svc.getFunctions()).toHaveLength(3);

      expect(() =>
        svc.registerFunctions([{ opts: { id: 'fake-string-id' } }]),
      ).toThrow('duplicate function id "fake-string-id"');
      expect(() => svc.registerFunctions([{ id: 'fake-config-id' }])).toThrow(
        'duplicate function id "fake-config-id"',
      );
      expect(svc.getFunctions()).toHaveLength(3);
    });

    it('fails closed on malformed/unknown shapes instead of silently skipping the check', () => {
      const config = makeConfigService({ INNGEST_EVENT_KEY: 'evt_test_123' });
      const svc = new InngestService(config);

      expect(() => svc.registerFunctions([{}])).toThrow(
        /could not resolve a function id/i,
      );
      expect(() => svc.registerFunctions([null])).toThrow(
        /could not resolve a function id/i,
      );
      expect(() => svc.registerFunctions([{ id: () => undefined }])).toThrow(
        /could not resolve a function id/i,
      );
      expect(() => svc.registerFunctions([{ id: '' }])).toThrow(
        /could not resolve a function id/i,
      );
      expect(svc.getFunctions()).toEqual([]);
    });

    it('keeps the defensive-copy contract after a successful registration', () => {
      const config = makeConfigService({ INNGEST_EVENT_KEY: 'evt_test_123' });
      const svc = new InngestService(config);
      svc.registerFunctions([makeRealV4Function('defensive-copy-fn')]);

      const first = svc.getFunctions();
      first.push('mutated-by-caller' as never);

      const second = svc.getFunctions();
      expect(second).toHaveLength(1);
      expect((second[0] as { opts: { id: string } }).opts.id).toBe(
        'defensive-copy-fn',
      );
    });
    it('resolves the bare id() method even without opts, and survives a throwing id() by falling back to opts.id', () => {
      const config = makeConfigService({ INNGEST_EVENT_KEY: 'evt_test_123' });
      const svc = new InngestService(config);

      // Method-only shape: no `opts`, no string `id` — the method branch is
      // the ONLY source of truth here.
      svc.registerFunctions([{ id: () => 'method-only-id' }]);
      expect(() =>
        svc.registerFunctions([
          {
            opts: { id: 'method-only-id' },
            id: (): string => {
              throw new Error('id() exploded');
            },
          },
        ]),
      ).toThrow('duplicate function id "method-only-id"');

      // A throwing id() must not crash the guard when `opts.id` resolves.
      svc.registerFunctions([
        {
          opts: { id: 'opts-fallback-id' },
          id: (): string => {
            throw new Error('id() exploded');
          },
        },
      ]);
      expect(svc.getFunctions()).toHaveLength(2);
    });

    it('keeps the mocked createFunction shape ({ opts, handler }) registrable and duplicate-checked', () => {
      const config = makeConfigService({ INNGEST_EVENT_KEY: 'evt_test_123' });
      const svc = new InngestService(config);

      // `beforeEach` calls `mockReset()`, which drops the factory
      // implementation declared at `jest.mock` time. Re-arm the exact
      // shape the module mock produces so this test proves THAT shape is
      // still registrable and duplicate-checked.
      inngestMock.__mocks.createFunctionMock.mockImplementation(
        (opts: unknown, handler: unknown) => ({ opts, handler }),
      );

      const fn: unknown = inngestMock.__mocks.createFunctionMock(
        { id: 'mocked-create-function-id' },
        () => undefined,
      );
      svc.registerFunctions([fn]);

      const duplicate: unknown = inngestMock.__mocks.createFunctionMock(
        { id: 'mocked-create-function-id' },
        () => undefined,
      );
      expect(() => svc.registerFunctions([duplicate])).toThrow(
        'duplicate function id "mocked-create-function-id"',
      );
      expect(svc.getFunctions()).toHaveLength(1);
    });
  });

  // ─── D-hardening — fail-closed posture on INNGEST_DEV / NODE_ENV ─────
  // The Inngest SDK derives its `mode` (cloud vs dev) from
  // `options.isDev` first, then `INNGEST_DEV`, then explicit URL. Dev mode
  // makes `serve()` accept UNSIGNED requests — a fatal bypass on
  // /api/inngest. We force `isDev: false` whenever NODE_ENV is
  // `staging` or `production`, regardless of INNGEST_DEV. In dev/test we
  // keep the SDK's default (relaxed) so the Inngest Dev Server works.
  describe('fail-closed mode forcing (D-hardening)', () => {
    it('passes isDev:false to the SDK when NODE_ENV=production (cloud mode enforced)', () => {
      const config = makeConfigService({
        INNGEST_EVENT_KEY: 'evt_prod',
        NODE_ENV: 'production',
      });

      const svc = new InngestService(config);
      void svc;

      expect(capturedConstructors).toHaveLength(1);
      const opts = capturedConstructors[0];
      expect(opts.isDev).toBe(false);
      // Confirm the keys are still forwarded — fail-closed posture does
      // not break the existing eventKey wiring.
      expect(opts.eventKey).toBe('evt_prod');
    });

    it('passes isDev:false to the SDK when NODE_ENV=staging (cloud mode enforced)', () => {
      const config = makeConfigService({
        INNGEST_EVENT_KEY: 'evt_staging',
        NODE_ENV: 'staging',
      });

      const svc = new InngestService(config);
      void svc;

      expect(capturedConstructors).toHaveLength(1);
      expect(capturedConstructors[0].isDev).toBe(false);
    });

    it('does NOT set isDev in dev mode (lets the Inngest Dev Server flow through unchanged)', () => {
      const config = makeConfigService({
        INNGEST_EVENT_KEY: undefined,
        NODE_ENV: 'development',
      });

      const svc = new InngestService(config);
      void svc;

      expect(capturedConstructors).toHaveLength(1);
      // `isDev` is undefined — the SDK falls back to its default (read
      // INNGEST_DEV from env). We deliberately do not flip dev mode.
      expect(capturedConstructors[0].isDev).toBeUndefined();
    });

    it('does NOT set isDev in test mode (parity with dev)', () => {
      const config = makeConfigService({
        INNGEST_EVENT_KEY: undefined,
        NODE_ENV: 'test',
      });

      const svc = new InngestService(config);
      void svc;

      expect(capturedConstructors).toHaveLength(1);
      expect(capturedConstructors[0].isDev).toBeUndefined();
    });

    it('forces isDev:false in production even when INNGEST_DEV is truthy in the env object (the bypass the gate is closing)', () => {
      // This is the precise regression: today the SDK reads INNGEST_DEV
      // and silently flips to dev (unsigned) mode. The fix pins isDev at
      // construction time so an INNGEST_DEV=1 env cannot demote the
      // client. Joi D-hardening catches the same value at boot in prod;
      // this is the belt-and-braces in case the boot guard is ever
      // bypassed.
      const config = makeConfigService({
        INNGEST_EVENT_KEY: 'evt_prod',
        NODE_ENV: 'production',
        INNGEST_DEV: '1',
      });

      const svc = new InngestService(config);
      void svc;

      expect(capturedConstructors).toHaveLength(1);
      const opts = capturedConstructors[0];
      expect(opts.isDev).toBe(false);
    });
  });
});
