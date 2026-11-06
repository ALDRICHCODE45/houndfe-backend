import { Global, Module, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import {
  disconnectIntegrationPrisma,
  integrationPrisma,
} from '../../../test/integration/reset-db';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { readEditorialVocabulary } from '../application/editorial-vocabulary-read';
import { CatalogEditorialReadModule } from '../catalog-editorial-read.module';
import type { EditorialContext } from '../application/catalog-editorial-core';
import { PrismaEditorialAuthority } from '../infrastructure/prisma-editorial-authority';
import { PrismaEditorialVocabularySnapshot } from '../infrastructure/prisma-editorial-vocabulary-snapshot';
import {
  installCanonicalVocabulary,
  uninstallVocabulary,
} from '../infrastructure/test-support/editorial-publication-postgres';

// S4: real PostgreSQL rows that do not decode as V2 answer a typed 409 in the
// editorial envelope; valid V2 rows read exactly as before.
const actorId = randomUUID();
const tenantId = randomUUID();
const v2 = () => ({
  schemaVersion: 2,
  commercialTitle: 'Correa de nylon 1.8 m',
  description: null,
  mediaRefs: [],
  familyCode: null,
  values: [],
  facts: [],
});
// Shape of a pre-V2 document; its contents must never reach the response.
const legacy = () => ({
  schemaVersion: 1,
  commercialTitle: 'secreto legado',
  attributes: { color: 'rojo' },
});

let prisma: PrismaClient;
@Global()
@Module({
  providers: [{ provide: PrismaService, useFactory: () => prisma }],
  exports: [PrismaService],
})
class IntegrationDatabaseModule {}
let installed = false;
let revision: string;
let app: INestApplication;

async function product(
  draft: unknown,
  published: unknown = null,
): Promise<string> {
  const productId = randomUUID();
  await prisma.product.create({
    data: { id: productId, tenantId, name: 'Producto ' + productId },
  });
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "catalog_editorial_states"
      ("tenantId", "productId", "cycle", "draftRevision", "basePublishedRevision",
       "draftDocument", "publishedRevision", "publishedDocument")
    VALUES (${tenantId}, ${productId}, 2,
      ${draft === null ? null : 3}, ${draft === null || published === null ? null : 1},
      CAST(${draft === null ? null : JSON.stringify(draft)} AS JSONB),
      ${published === null ? null : 1},
      CAST(${published === null ? null : JSON.stringify(published)} AS JSONB))`);
  return productId;
}
const get = (productId: string, suffix = '') =>
  request(app.getHttpServer() as Server)
    .get(`/products/${productId}/editorial${suffix}`)
    .set('Authorization', 'Bearer synthetic')
    .set('Editorial-Vocabulary-Revision', revision);

beforeAll(async () => {
  prisma = integrationPrisma();
  await installCanonicalVocabulary(prisma);
  installed = true;
  revision = (
    await readEditorialVocabulary(new PrismaEditorialVocabularySnapshot(prisma))
  ).vocabularyRevision;
  await prisma.tenant.create({
    data: { id: tenantId, name: 'Unreadable', slug: 'unreadable-' + tenantId },
  });
  const module = await Test.createTestingModule({
    imports: [
      IntegrationDatabaseModule,
      ClsModule.forRoot({ global: true, middleware: { mount: true } }),
      CatalogEditorialReadModule,
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue({
      canActivate(context: ExecutionContext) {
        const req = context.switchToHttp().getRequest<Request>();
        if (req.headers.authorization !== 'Bearer synthetic')
          throw new UnauthorizedException();
        req.user = { userId: actorId, tenantId, isSuperAdmin: false };
        return true;
      },
    })
    // Read authority is pinned by the HTTP specs; this spec is about stored state.
    .overrideProvider(PrismaEditorialAuthority)
    .useValue({
      resolve: (context: EditorialContext) =>
        Promise.resolve({ ...context, activeMember: true, canRead: true }),
    })
    .compile();
  app = module.createNestApplication();
  await app.init();
}, 60_000);

afterAll(async () => {
  try {
    await app?.close();
    await prisma.$executeRaw(
      Prisma.sql`DELETE FROM "catalog_editorial_states" WHERE "tenantId" = ${tenantId}`,
    );
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
  } finally {
    try {
      // Never truncate a vocabulary this spec did not install.
      if (installed) await uninstallVocabulary(prisma);
    } finally {
      await disconnectIntegrationPrisma();
    }
  }
});

describe('unreadable stored editorial state on PostgreSQL (S4)', () => {
  const unreadable = (response: request.Response) => {
    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      statusCode: 409,
      error: 'EDITORIAL_STATE_UNREADABLE',
    });
    expect(response.text).not.toContain('secreto');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['editorial-contract-version']).toBe('2');
    expect(response.headers['editorial-vocabulary-revision']).toBeUndefined();
  };

  it('a legacy Draft answers 409 EDITORIAL_STATE_UNREADABLE', async () => {
    unreadable(await get(await product(legacy())));
  });

  it('a legacy Published answers 409 even beside a valid Draft', async () => {
    unreadable(await get(await product(v2(), legacy())));
  });

  it('a valid V2 state reads unchanged', async () => {
    const productId = await product(v2(), v2());
    const response = await get(productId);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      contractVersion: 2,
      vocabularyRevision: revision,
      state: {
        cycle: 2,
        draft: { revision: 3, basePublishedRevision: 1, document: v2() },
        published: { revision: 1, document: v2() },
      },
    });
    expect(response.headers['editorial-contract-version']).toBe('2');
    expect(response.headers['editorial-vocabulary-revision']).toBe(revision);
  });

  it('readiness keeps reporting a legacy Draft as DRAFT_INVALID', async () => {
    const response = await get(await product(legacy()), '/draft/readiness');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ready: false });
    expect(response.text).toContain('DRAFT_INVALID');
    expect(response.text).not.toContain('secreto');
  });
});
