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
