/**
 * Slice D.3 — InngestController tests.
 *
 * The controller exposes `/api/inngest` and delegates (req, res) to the
 * `serve({ client, functions, signingKey })` middleware from
 * `inngest/express`. It is JWT-EXCLUDED (no `@UseGuards`), so its ONLY
 * protection is Inngest's own signature verification, which `serve()`
 * performs when a `signingKey` is provided.
 *
 * What this spec proves:
 *
 *   - The controller is reachable on `api/inngest` for ALL HTTP methods
 *     (GET / PUT / POST — Inngest uses GET for introspection, PUT for
 *     sync, POST for events).
 *   - The controller is JWT-EXCLUDED — a request without `Authorization`
 *     is NOT rejected by us; it reaches the Inngest SDK, which decides.
 *     We simulate the SDK's signed/unsigned behavior with a mock.
 *   - The controller forwards (req, res) to a memoized `serve()` handler
 *     built ONCE at construction (per Inngest recommendation), not per
 *     request.
 *   - The controller passes the configured `INNGEST_SIGNING_KEY` to
 *     `serve({ signingKey })` — that is the security gate. A missing key
 *     in dev is allowed (Dev Server does not sign) but a key IS required
 *     for staging/production by Joi D.4, so by the time this controller
 *     is constructed in staging/prod, the key is present.
 *   - Triangulates that an "unsigned" request to the Inngest SDK surface
 *     is rejected with 401 by the SDK (mocked) — the controller does not
 *     second-guess it.
 *
 * Mock strategy: `inngest/express` is replaced with a fake `serve()` that
 * returns a `(req, res, next) => void` middleware we control. The fake
 * mirrors the production behavior: 401 on unsigned production requests,
 * 200 on signed ones.
 */
import {
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';

// Captured serve() options + a controllable middleware factory.
const serveCalls: Array<{
  client: unknown;
  functions: unknown;
  signingKey?: string;
}> = [];

jest.mock('inngest/express', () => {
  // The fake serve() captures its options and returns a middleware that
  // decides 200 vs 401 based on the presence of an X-Inngest-Signature
  // header — exactly mirroring how the real SDK gates prod requests.
  return {
    serve: jest.fn((opts: {
      client: unknown;
      functions: unknown;
      signingKey?: string;
    }) => {
      serveCalls.push(opts);
      return (req: any, res: any) => {
        if (opts.signingKey) {
          // Signed mode: reject unsigned requests with 401.
          if (!req.headers['x-inngest-signature']) {
            res.status(401).json({
              error: 'unauthorized',
              message: 'missing signature',
            });
            return;
          }
        }
        // Signed OR dev (no key): echo 200.
        res.status(200).json({ ok: true, framework: 'mock' });
      };
    }),
  };
});

import { InngestController } from './inngest.controller';
import { InngestService } from './inngest.service';

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

/**
 * InngestService double that returns whatever client/functions the
 * controller will hand to serve(). The SDK is mocked separately, so the
 * "client" only needs to be a stable object reference.
 */
function makeInngestService() {
  const client = { id: 'houndfe-backend', __mockClient: true };
  return {
    getClient: jest.fn().mockReturnValue(client),
    getFunctions: jest.fn().mockReturnValue([]),
    getClientId: jest.fn().mockReturnValue('houndfe-backend'),
    // for type compatibility with the real service surface the controller uses:
    send: jest.fn(),
    getEventKey: jest.fn(),
  } as unknown as InngestService;
}

describe('InngestController — /api/inngest (D.3)', () => {
  let app: INestApplication;
  let inngestService: ReturnType<typeof makeInngestService>;
  let config: ReturnType<typeof makeConfigService>;

  beforeEach(async () => {
    serveCalls.length = 0;
    inngestService = makeInngestService();
    config = makeConfigService({
      INNGEST_SIGNING_KEY: 'signkey_test_abc123',
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [InngestController],
      providers: [
        { provide: InngestService, useValue: inngestService },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('wires serve() at construction with the configured client and signing key (memoized)', () => {
    expect(serveCalls).toHaveLength(1);
    expect(serveCalls[0].client).toBe(inngestService.getClient());
    expect(serveCalls[0].signingKey).toBe('signkey_test_abc123');
    expect(serveCalls[0].functions).toEqual([]);
  });

  it('returns 401 for an unsigned request when a signing key is configured (signed mode)', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/inngest')
      .send({})
      .expect(401);

    expect(res.body.error).toBe('unauthorized');
  });

  it('returns 200 for a SIGNED request when a signing key is configured', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/inngest')
      .set('X-Inngest-Signature', 't=123&s=deadbeef')
      .send({})
      .expect(200);

    expect(res.body).toEqual({ ok: true, framework: 'mock' });
  });

  it('matches ALL HTTP methods (GET / PUT / POST) on the same path', async () => {
    // GET — Inngest uses GET for introspection.
    await request(app.getHttpServer())
      .get('/api/inngest')
      .set('X-Inngest-Signature', 't=1&s=s')
      .expect(200);

    // PUT — sync calls.
    await request(app.getHttpServer())
      .put('/api/inngest')
      .set('X-Inngest-Signature', 't=2&s=s')
      .expect(200);

    // POST — async events.
    await request(app.getHttpServer())
      .post('/api/inngest')
      .set('X-Inngest-Signature', 't=3&s=s')
      .expect(200);
  });

  it('is JWT-EXCLUDED — requests with no Authorization header are NOT rejected by us (they reach the SDK)', async () => {
    // No Authorization header at all. The controller must NOT block this
    // before reaching the SDK. With the fake serve() in signed mode,
    // absence of signature ⇒ 401 (SDK gate). Crucially: the response
    // comes from the SDK, not from any JwtAuthGuard in our stack —
    // proving the controller carries no JWT guard.
    const res = await request(app.getHttpServer())
      .put('/api/inngest')
      .send({})
      .expect(401);

    expect(res.body.error).toBe('unauthorized');
  });
});

describe('InngestController — dev mode (no signing key) (D.3)', () => {
  let app: INestApplication;
  let inngestService: ReturnType<typeof makeInngestService>;

  beforeEach(async () => {
    serveCalls.length = 0;
    inngestService = makeInngestService();
    const config = makeConfigService({
      // No INNGEST_SIGNING_KEY — dev / Inngest Dev Server mode.
      INNGEST_SIGNING_KEY: undefined,
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [InngestController],
      providers: [
        { provide: InngestService, useValue: inngestService },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('does NOT require a signing key at the controller layer (Joi D.4 gates prod; dev is permissive)', () => {
    expect(serveCalls).toHaveLength(1);
    expect(serveCalls[0].signingKey).toBeUndefined();
  });

  it('still delegates to serve() in dev mode — unsigned requests pass through (the Dev Server is local)', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/inngest')
      .send({})
      .expect(200);

    expect(res.body.ok).toBe(true);
  });
});