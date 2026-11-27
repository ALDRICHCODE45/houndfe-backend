/**
 * customers-bulk-actions / T1 (S3, frontend L3.9) — the app-wide CORS config
 * exposes `Content-Disposition` so a cross-origin frontend can read the CSV /
 * ZIP filename. Origins, credentials and the editorial overrides are unchanged.
 */
import { Controller, Get, Header, Post } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import type { Request } from 'express';
import { appCors } from './editorial-cors';

@Controller()
class Probe {
  @Post('customers/bulk/export')
  @Header('Content-Disposition', 'attachment; filename="clientes-x.csv"')
  export() {
    return 'csv';
  }
  @Get('products/id/editorial')
  editorial() {
    return {};
  }
}

const exposedEditorial =
  'Editorial-Contract-Version,Editorial-Vocabulary-Revision';

describe.each([
  ['configured origins + credentials', true],
  ['open development fallback', false],
])('appCors — %s', (_label, configured) => {
  let app: INestApplication;
  const server = () => app.getHttpServer() as Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [Probe],
    }).compile();
    app = moduleRef.createNestApplication();
    app.enableCors(
      configured
        ? appCors({ origin: ['https://allowed.test'], credentials: true })
        : appCors(),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('exposes Content-Disposition on an actual cross-origin response', async () => {
    const response = await request(server())
      .post('/customers/bulk/export')
      .set('Origin', 'https://allowed.test');
    expect(response.status).toBe(201);
    expect(response.headers['access-control-expose-headers']).toBe(
      'Content-Disposition',
    );
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="clientes-x.csv"',
    );
    expect(response.headers['access-control-allow-origin']).toBe(
      configured ? 'https://allowed.test' : '*',
    );
    expect(response.headers['access-control-allow-credentials']).toBe(
      configured ? 'true' : undefined,
    );
  });

  it('keeps the origin policy: a foreign origin gets no allow-origin', async () => {
    const response = await request(server())
      .post('/customers/bulk/export')
      .set('Origin', 'https://evil.test');
    expect(response.headers['access-control-allow-origin']).toBe(
      configured ? undefined : '*',
    );
  });

  it('preflight still reflects the requested headers (unchanged)', async () => {
    const response = await request(server())
      .options('/customers/bulk/export')
      .set('Origin', 'https://allowed.test')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Authorization,Content-Type');
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-headers']).toBe(
      'Authorization,Content-Type',
    );
  });

  it('editorial routes keep their own exposed headers', async () => {
    const response = await request(server())
      .get('/products/id/editorial')
      .set('Origin', 'https://allowed.test');
    expect(response.headers['access-control-expose-headers']).toBe(
      exposedEditorial,
    );
  });
});

// Advisory R3-appcors-overrides-exposed: caller exposedHeaders are merged
// (deduped) with Content-Disposition, never silently discarded.
describe('appCors — caller exposedHeaders', () => {
  function resolve(options: CorsOptions, url = '/customers/bulk/export') {
    const req = {
      method: 'POST',
      originalUrl: url,
      get: () => undefined,
    } as unknown as Request;
    let resolved: CorsOptions | undefined;
    appCors(options)(req, (err, value) => {
      expect(err).toBeNull();
      resolved = value;
    });
    return resolved;
  }

  it.each<[CorsOptions['exposedHeaders'], string[]]>([
    [undefined, ['Content-Disposition']],
    ['X-Request-Id', ['X-Request-Id', 'Content-Disposition']],
    [
      'X-Request-Id, X-Total',
      ['X-Request-Id', 'X-Total', 'Content-Disposition'],
    ],
    [['X-Request-Id'], ['X-Request-Id', 'Content-Disposition']],
    [
      ['content-disposition', 'X-A'],
      ['content-disposition', 'X-A'],
    ],
    ['', ['Content-Disposition']],
    [[], ['Content-Disposition']],
  ])('%j → %j', (exposedHeaders, expected) => {
    const options: CorsOptions = { origin: ['https://allowed.test'] };
    if (exposedHeaders !== undefined) options.exposedHeaders = exposedHeaders;
    expect(resolve(options)).toEqual({
      origin: ['https://allowed.test'],
      exposedHeaders: expected,
    });
  });

  it('does not mutate the caller options', () => {
    const options: CorsOptions = { exposedHeaders: ['X-A'] };
    resolve(options);
    expect(options).toEqual({ exposedHeaders: ['X-A'] });
  });

  it('editorial routes still use their own exposed headers', () => {
    const req = {
      method: 'GET',
      originalUrl: '/products/id/editorial',
      get: () => undefined,
    } as unknown as Request;
    let resolved: CorsOptions | undefined;
    appCors({ exposedHeaders: 'X-A' })(req, (_err, value) => {
      resolved = value;
    });
    expect(resolved?.exposedHeaders).toEqual([
      'Editorial-Contract-Version',
      'Editorial-Vocabulary-Revision',
    ]);
  });
});
