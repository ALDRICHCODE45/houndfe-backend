import { Global, Module } from '@nestjs/common';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { Request } from 'express';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { CatalogEditorialVocabularyModule } from '../catalog-editorial-vocabulary.module';
import { editorialCors } from './editorial-cors';

const binding = {
  definitionId: 'd',
  definitionCode: 'custom.note',
  owner: 'product',
  sortOrder: 0,
  exposure: 'DETAIL',
  searchable: false,
  publicationCheck: 'when_asserted',
  policy: { route: 'pending' },
};
const definition = {
  id: 'd',
  code: 'custom.note',
  label: 'Note',
  type: 'text',
};
const family = {
  id: 'f',
  code: 'custom.family',
  label: 'Family',
  bindings: [binding],
};
const vocabulary = {
  semanticsVersion: 'editorial-production-1',
  families: [family],
  definitions: [definition],
};
const stored = () => ({
  metadata: { id: 'global', semanticsVersion: 'editorial-production-1' },
  families: [
    {
      ...family,
      bindings: [{ ...binding, familyId: 'f', policy: { ...binding.policy } }],
    },
  ],
  definitions: [
    {
      ...definition,
      numericPolicy: null,
      units: [],
      options: [],
      groups: [],
      aliases: [],
    },
  ],
});
// Independent JSON oracle for this ASCII/integer fixture, not the production hasher.
const keys = [
  'bindings',
  'code',
  'contractVersion',
  'definitionCode',
  'definitionId',
  'definitions',
  'exposure',
  'families',
  'id',
  'label',
  'owner',
  'policy',
  'publicationCheck',
  'route',
  'searchable',
  'semanticsVersion',
  'sortOrder',
  'type',
  'vocabulary',
];
const revision =
  'ev2-sha256-' +
  createHash('sha256')
    .update(JSON.stringify({ contractVersion: 2, vocabulary }, keys))
    .digest('hex');
const db = {
  user: { findUnique: jest.fn() },
  role: { findFirst: jest.fn() },
  tenantMembership: { findMany: jest.fn() },
  $queryRaw: jest.fn(),
};
@Global()
@Module({
  providers: [{ provide: PrismaService, useValue: db }],
  exports: [PrismaService],
})
class Database {}

describe('registered vocabulary composition with synthetic Prisma I/O and JWT', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        Database,
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        CatalogEditorialVocabularyModule,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          context.switchToHttp().getRequest<Request>().user = {
            userId: 'actor',
            tenantId: null,
            isSuperAdmin: true,
          };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.enableCors(editorialCors());
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    db.user.findUnique.mockResolvedValue({ isActive: true });
    db.role.findFirst.mockResolvedValue({ id: 'global-role' });
    db.$queryRaw.mockResolvedValue([{ snapshot: stored() }]);
  });
  const get = () =>
    request(app.getHttpServer() as Server)
      .get('/catalog-editorial/vocabulary')
      .set('Origin', 'https://editor.test');
  function check(response: request.Response, status: number, body: unknown) {
    expect(response.status).toBe(status);
    expect(response.body).toEqual(body);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-expose-headers']).toBe(
      'Editorial-Contract-Version,Editorial-Vocabulary-Revision',
    );
    expect(response.headers['editorial-contract-version']).toBe('2');
    expect(response.headers['editorial-vocabulary-revision']).toBe(
      status === 200 ? revision : undefined,
    );
  }
  it('materializes stored metadata with an independently calculated matching digest', async () => {
    const snapshot = stored();
    const before = structuredClone(snapshot);
    db.$queryRaw.mockResolvedValue([{ snapshot }]);
    check(await get().set('x-tenant-id', 'ignored'), 200, {
      contractVersion: 2,
      vocabularyRevision: revision,
      vocabulary,
    });
    expect(snapshot).toEqual(before);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(db.tenantMembership.findMany).not.toHaveBeenCalled();
    const [sql] = db.$queryRaw.mock.calls[0] as [readonly string[]];
    expect(sql.join('')).toContain('editorial_vocabulary_metadata');
    expect(db.role.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
      db.$queryRaw.mock.invocationCallOrder[0],
    );
  });
  it('serves definitions[].description from the same single statement without changing the revision', async () => {
    const [first, ...rest] = vocabulary.definitions;
    db.$queryRaw.mockResolvedValue([
      {
        snapshot: stored(),
        descriptions: { [first.code]: 'Ayuda para el usuario.' },
      },
    ]);
    check(await get(), 200, {
      contractVersion: 2,
      // Same digest as the undescribed vocabulary: descriptions are outside it.
      vocabularyRevision: revision,
      vocabulary: {
        ...vocabulary,
        definitions: [
          { ...first, description: 'Ayuda para el usuario.' },
          ...rest,
        ],
      },
    });
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('serves production family sections without changing the revision', async () => {
    const food = (raw: ReturnType<typeof stored>) => {
      raw.families[0].code = 'food';
      raw.families[0].bindings[0].definitionCode = 'text.instructions';
      raw.definitions[0].code = 'text.instructions';
      return raw;
    };
    const bare = {
      ...vocabulary,
      families: [
        {
          ...family,
          code: 'food',
          bindings: [{ ...binding, definitionCode: 'text.instructions' }],
        },
      ],
      definitions: [{ ...definition, code: 'text.instructions' }],
    };
    // Oracle over the vocabulary WITHOUT sections.
    const foodRevision =
      'ev2-sha256-' +
      createHash('sha256')
        .update(JSON.stringify({ contractVersion: 2, vocabulary: bare }, keys))
        .digest('hex');
    db.$queryRaw.mockResolvedValue([{ snapshot: food(stored()) }]);
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers['editorial-vocabulary-revision']).toBe(
      foodRevision,
    );
    expect(response.body).toEqual({
      contractVersion: 2,
      vocabularyRevision: foodRevision,
      vocabulary: {
        ...bare,
        families: [
          {
            ...bare.families[0],
            sections: [{ code: 'uso', label: 'Uso', sortOrder: 4 }],
            bindings: [
              {
                ...bare.families[0].bindings[0],
                sectionCode: 'uso',
                sectionSortOrder: 0,
              },
            ],
          },
        ],
      },
    });
  });

  it('fails closed, without leaking, when the description column is malformed', async () => {
    db.$queryRaw.mockResolvedValue([
      { snapshot: stored(), descriptions: ['not', 'an', 'object'] },
    ]);
    check(await get(), 500, { statusCode: 500, error: 'INTERNAL_ERROR' });
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it.each([
    'Editorial-Contract-Version',
    'Editorial-Adoption',
    'Editorial-Vocabulary-Revision',
    'Editorial-Care-Confirmation',
    'Idempotency-Key',
  ])('rejects prohibited %s before reading the snapshot', async (name) => {
    check(await get().set(name, ''), 400, {
      statusCode: 400,
      error: 'MALFORMED',
    });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
  it.each(['missing metadata', 'invalid policy', 'outage'])(
    'fails the whole response for %s',
    async (mode) => {
      const snapshot = stored();
      if (mode === 'missing metadata')
        Object.assign(snapshot, { metadata: null });
      if (mode === 'invalid policy')
        Object.assign(snapshot.families[0].bindings[0].policy, {
          private: 'secret',
        });
      db.$queryRaw.mockResolvedValue([{ snapshot }]);
      if (mode === 'outage')
        db.$queryRaw.mockRejectedValue(new Error('private database detail'));
      const before = structuredClone(snapshot);
      check(await get(), 500, {
        statusCode: 500,
        error:
          mode === 'outage'
            ? 'INTERNAL_ERROR'
            : 'EDITORIAL_VOCABULARY_UNREPRESENTABLE',
      });
      expect(db.$queryRaw).toHaveBeenCalledTimes(1);
      expect(snapshot).toEqual(before);
    },
  );
});
