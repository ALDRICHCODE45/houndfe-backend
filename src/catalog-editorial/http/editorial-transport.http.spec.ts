import { Controller, Get, HttpException, UseFilters } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import type { RequestHandler } from 'express';
import request from 'supertest';
import { EditorialVocabularyUnrepresentableError } from '../application/editorial-vocabulary-read';
import { editorialCors } from './editorial-cors';
import { EditorialHttpFilter } from './editorial-http.filter';

let failure: unknown;
@Controller('products/id/editorial')
@UseFilters(EditorialHttpFilter)
class Probe {
  @Get()
  read() {
    throw failure;
  }
  @Get('draft/readiness')
  readiness() {
    return { ready: true };
  }
}
const allowed =
  'Authorization,Content-Type,Cache-Control,Pragma,Editorial-Vocabulary-Revision,Idempotency-Key,Editorial-Care-Confirmation';
const exposed = 'Editorial-Contract-Version,Editorial-Vocabulary-Revision';
const routes = [
  ['GET', '/catalog-editorial/vocabulary'],
  ['HEAD', '/catalog-editorial/vocabulary'],
  ['GET', '/products/id/editorial'],
  ['GET', '/products/id/editorial/context'],
  ['GET', '/products/id/editorial/draft/readiness'],
  ['HEAD', '/products/id/editorial/draft/readiness'],
  ['PUT', '/products/id/editorial/draft'],
  ...['initialize', 'publish', 'discard'].map((action) => [
    'POST',
    `/products/id/editorial/draft/${action}`,
  ]),
  ['POST', '/products/id/editorial/published/unpublish'],
  ['POST', '/PRODUCTS/id/EDITORIAL/PUBLISHED/UNPUBLISH/'],
  ['GET', '/PRODUCTS/not-a-uuid/EDITORIAL/CONTEXT/?x=1'],
];
const siblings = [
  ['GET', '/products/id'],
  ['POST', '/products/id/editorial'],
  ['GET', '/products/id/editorial/context-extra'],
  ['GET', '/products/id/editorial/context/extra'],
  ['GET', '/products/id/media'],
  ['GET', '/catalog-editorial/vocabulary-extra'],
  ['GET', '/products/id/editorial/draft'],
  ['POST', '/products/id/editorial/draft/readiness'],
  ['GET', '/products/id/editorial/draft/readiness-extra'],
  ['GET', '/products/id/editorial/draft/readiness/extra'],
  ['GET', '/products/a/b/editorial'],
  ['GET', '/products/id/editorial/published/unpublish'],
  ['POST', '/products/id/editorial/published'],
  ['POST', '/products/id/editorial/draft/unpublish'],
  ['POST', '/products/id/editorial/published/publish'],
];

describe.each([false, true])('editorial CORS configured=%s', (configured) => {
  let app: INestApplication;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [Probe],
    }).compile();
    app = module.createNestApplication();
    app.enableCors(
      editorialCors(
        configured
          ? { origin: ['https://allowed.test'], credentials: true }
          : {},
      ),
    );
    const staleRevision: RequestHandler = (_req, res, next) => {
      res.setHeader('Editorial-Vocabulary-Revision', 'stale');
      next();
    };
    app.use(staleRevision);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  const preflight = (
    method: string,
    path: string,
    origin = 'https://allowed.test',
  ) =>
    request(app.getHttpServer() as Server)
      .options(path)
      .set('Origin', origin)
      .set('Access-Control-Request-Method', method)
      .set(
        'Access-Control-Request-Headers',
        'Authorization,Editorial-Contract-Version,Editorial-Adoption,X-Custom',
      );
  test.each([
    '/catalog-editorial/vocabulary',
    '/products/id/editorial',
    '/products/id/editorial/context',
    '/products/id/editorial/draft/readiness',
  ])('allows authenticated browser cache headers for %s', async (path) => {
    const response = await request(app.getHttpServer() as Server)
      .options(path)
      .set('Origin', 'https://allowed.test')
      .set('Access-Control-Request-Method', 'GET')
      .set(
        'Access-Control-Request-Headers',
        'authorization,cache-control,pragma,editorial-vocabulary-revision',
      );
    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(response.headers['access-control-allow-headers']).toBe(
      'Authorization,Content-Type,Cache-Control,Pragma,Editorial-Vocabulary-Revision,Idempotency-Key,Editorial-Care-Confirmation',
    );
    expect(response.headers['access-control-allow-origin']).toBe(
      configured ? 'https://allowed.test' : '*',
    );
    expect(response.headers['access-control-allow-credentials']).toBe(
      configured ? 'true' : undefined,
    );
    expect(response.headers['access-control-expose-headers']).toBe(exposed);
  });
  test.each(routes)(
    '%s %s uses exact editorial headers',
    async (method, path) => {
      const response = await preflight(method, path);
      expect(response.status).toBe(204);
      expect(response.text).toBe('');
      expect(response.headers['access-control-allow-headers']).toBe(allowed);
      expect(response.headers['access-control-expose-headers']).toBe(exposed);
      expect(response.headers['access-control-allow-origin']).toBe(
        configured ? 'https://allowed.test' : '*',
      );
      expect(response.headers['access-control-allow-credentials']).toBe(
        configured ? 'true' : undefined,
      );
      expect(response.headers['access-control-allow-methods']).toBe(
        'GET,HEAD,PUT,PATCH,POST,DELETE',
      );
    },
  );
  test.each(siblings)(
    '%s %s preserves default reflection',
    async (method, path) => {
      const response = await preflight(method, path);
      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-headers']).toBe(
        'Authorization,Editorial-Contract-Version,Editorial-Adoption,X-Custom',
      );
      expect(response.headers['access-control-expose-headers']).toBeUndefined();
      expect(response.headers['access-control-allow-origin']).toBe(
        configured ? 'https://allowed.test' : '*',
      );
      expect(response.headers['access-control-allow-credentials']).toBe(
        configured ? 'true' : undefined,
      );
    },
  );
  it('exposes editorial headers on an actual readiness GET', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get('/products/id/editorial/draft/readiness')
      .set('Origin', 'https://allowed.test');
    expect(response.status).toBe(200);
    expect(response.headers['access-control-expose-headers']).toBe(exposed);
    expect(response.headers['access-control-allow-origin']).toBe(
      configured ? 'https://allowed.test' : '*',
    );
  });
  it('preserves denied-origin behavior', async () => {
    const response = await preflight(
      'GET',
      '/products/id/editorial',
      'https://other.test',
    );
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(
      configured ? undefined : '*',
    );
  });
  test.each([
    [new Error('CONFLICT'), 409, 'CONFLICT'],
    [new Error('VOCABULARY_CHANGED'), 409, 'VOCABULARY_CHANGED'],
    [
      new EditorialVocabularyUnrepresentableError(new Error('private')),
      500,
      'EDITORIAL_VOCABULARY_UNREPRESENTABLE',
    ],
    [new Error('EDITORIAL_VOCABULARY_UNREPRESENTABLE'), 500, 'INTERNAL_ERROR'],
    [new TypeError('private'), 500, 'INTERNAL_ERROR'],
    [new HttpException('private', 409), 409, 'CONFLICT'],
    [new HttpException('private', 500), 500, 'INTERNAL_ERROR'],
  ])('sanitizes %s', async (error, status, code) => {
    failure = error;
    const response = await request(app.getHttpServer() as Server)
      .get('/products/id/editorial')
      .set('Origin', 'https://allowed.test');
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ statusCode: status, error: code });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['editorial-contract-version']).toBe('2');
    expect(response.headers['editorial-vocabulary-revision']).toBeUndefined();
    expect(response.headers['access-control-expose-headers']).toBe(exposed);
  });
  it.each([
    ['malformed JSON', '{', 400],
    ['oversized JSON', JSON.stringify({ text: 'x'.repeat(110000) }), 413],
  ])('leaves %s outside the local envelope', async (_name, body, status) => {
    const response = await request(app.getHttpServer() as Server)
      .get('/products/id/editorial')
      .set('Content-Type', 'application/json')
      .send(body);
    expect(response.status).toBe(status);
    expect(response.body).toHaveProperty('message');
    expect(response.headers['editorial-contract-version']).toBeUndefined();
  });
  it('leaves unmatched routes outside the local envelope', async () => {
    const response = await request(app.getHttpServer() as Server).get(
      '/products/id/editorial/missing',
    );
    expect(response.status).toBe(404);
    expect(response.body).toHaveProperty('message');
    expect(response.headers['editorial-contract-version']).toBeUndefined();
  });
});
