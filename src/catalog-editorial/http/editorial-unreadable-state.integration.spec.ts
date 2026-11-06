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
import { decodeRecordedEditorialStateV2 } from '../application/editorial-recorded-state-v2';
import { readEditorialVocabulary } from '../application/editorial-vocabulary-read';
import { CatalogEditorialReadModule } from '../catalog-editorial-read.module';
import type { EditorialContext } from '../application/catalog-editorial-core';
import { PrismaEditorialAuthority } from '../infrastructure/prisma-editorial-authority';
import { PrismaEditorialVocabularySnapshot } from '../infrastructure/prisma-editorial-vocabulary-snapshot';
import {
  installCanonicalVocabulary,
  uninstallVocabulary,
} from '../infrastructure/test-support/editorial-publication-postgres';

// S5: the showcase repair, driven with the TS decoder instead of dist/.
type RepairReport = {
  applied: boolean;
  rowsMatched: number;
  slotsCleared: number;
  rowsDeleted: number;
  rowsKeptReferenced: number;
  products: string[];
};
const repair =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../../scripts/dev-showcase/editorial-repair.cjs') as {
    LEGACY_EDITORIAL_PRODUCTS: string[];
    repairLegacyEditorialStates(
      prisma: PrismaClient,
      options: { apply: boolean; decode: unknown },
    ): Promise<RepairReport>;
  };

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
let centroTenantId = '';
const centroTenant = () => centroTenantId;
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
  {
    tenant = tenantId as string,
    name = 'Producto ' + randomUUID(),
  }: { tenant?: string; name?: string } = {},
): Promise<string> {
  const productId = randomUUID();
  await prisma.product.create({
    data: { id: productId, tenantId: tenant, name },
  });
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "catalog_editorial_states"
      ("tenantId", "productId", "cycle", "draftRevision", "basePublishedRevision",
       "draftDocument", "publishedRevision", "publishedDocument")
    VALUES (${tenant}, ${productId}, 2,
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
        const bearer = req.headers.authorization;
        if (bearer !== 'Bearer synthetic' && bearer !== 'Bearer centro')
          throw new UnauthorizedException();
        req.user = {
          userId: actorId,
          tenantId: bearer === 'Bearer centro' ? centroTenant() : tenantId,
          isSuperAdmin: false,
        };
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

describe('showcase editorial repair on PostgreSQL (S5)', () => {
  // The repair is scoped to slug centro; borrow it only when the test DB lacks it.
  let centroId: string;
  let createdCentro = false;
  const [ruffwear, kong, flexi, diamond] = repair.LEGACY_EDITORIAL_PRODUCTS;
  const run = (apply: boolean) =>
    repair.repairLegacyEditorialStates(prisma, {
      apply,
      decode: decodeRecordedEditorialStateV2,
    });
  const slots = (productId: string) =>
    prisma.$queryRaw<
      {
        draftRevision: number | null;
        publishedRevision: number | null;
        unpublishedRevision: number | null;
      }[]
    >(Prisma.sql`
      SELECT "draftRevision", "publishedRevision", "unpublishedRevision"
      FROM "catalog_editorial_states"
      WHERE "tenantId" = ${centroId} AND "productId" = ${productId}`);

  beforeAll(async () => {
    const existing = await prisma.tenant.findUnique({
      where: { slug: 'centro' },
    });
    if (existing) {
      const clash = await prisma.product.count({
        where: {
          tenantId: existing.id,
          name: { in: repair.LEGACY_EDITORIAL_PRODUCTS },
        },
      });
      if (clash) throw new Error('Test DB already has the showcase products');
      centroId = existing.id;
      centroTenantId = centroId;
    } else {
      centroId = randomUUID();
      await prisma.tenant.create({
        data: { id: centroId, name: 'Centro (repair)', slug: 'centro' },
      });
      createdCentro = true;
      centroTenantId = centroId;
    }
  });
  afterAll(async () => {
    const owned = {
      tenantId: centroId,
      name: { in: repair.LEGACY_EDITORIAL_PRODUCTS },
    };
    const ids = (await prisma.product.findMany({ where: owned })).map(
      (p) => p.id,
    );
    await prisma.$executeRaw(Prisma.sql`
      DELETE FROM "catalog_editorial_create_receipts"
      WHERE "tenantId" = ${centroId} AND "productId" IN (${Prisma.join(ids.length ? ids : [''])})`);
    await prisma.$executeRaw(Prisma.sql`
      DELETE FROM "catalog_editorial_states"
      WHERE "tenantId" = ${centroId} AND "productId" IN (${Prisma.join(ids.length ? ids : [''])})`);
    await prisma.product.deleteMany({ where: owned });
    if (createdCentro)
      await prisma.tenant.deleteMany({ where: { id: centroId } });
  });

  it('dry-runs, then clears only non-V2 slots, keeping referenced rows and receipts', async () => {
    const tenant = { tenant: centroId };
    const a = await product(legacy(), null, { ...tenant, name: ruffwear });
    const b = await product(v2(), legacy(), { ...tenant, name: kong });
    const c = await product(legacy(), legacy(), { ...tenant, name: flexi });
    const d = await product(v2(), v2(), { ...tenant, name: diamond });
    // Same name in another tenant: out of scope.
    const foreign = await product(legacy(), null, { name: ruffwear });
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "catalog_editorial_create_receipts"
        ("tenantId", "productId", "actorId", "idempotencyKey", "request", "result")
      VALUES (${centroId}, ${c}, ${actorId}, 'legacy-key', '{}'::jsonb, '{}'::jsonb)`);

    const dry = await run(false);
    expect(dry).toEqual({
      applied: false,
      rowsMatched: 4,
      slotsCleared: 4,
      rowsDeleted: 1,
      rowsKeptReferenced: 1,
      products: [ruffwear, kong, flexi].sort(),
    });
    expect(JSON.stringify(dry)).not.toContain('secreto');
    expect(await slots(a)).toHaveLength(1);

    expect(await run(true)).toEqual({ ...dry, applied: true });
    expect(await slots(a)).toEqual([]);
    expect(await slots(b)).toEqual([
      { draftRevision: 3, publishedRevision: null, unpublishedRevision: 1 },
    ]);
    expect(await slots(c)).toEqual([
      { draftRevision: null, publishedRevision: null, unpublishedRevision: 1 },
    ]);
    expect(await slots(d)).toEqual([
      { draftRevision: 3, publishedRevision: 1, unpublishedRevision: null },
    ]);
    const receipts = await prisma.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT count(*)::int AS n FROM "catalog_editorial_create_receipts"
      WHERE "tenantId" = ${centroId} AND "productId" = ${c}`);
    expect(receipts).toEqual([{ n: 1 }]);
    // The foreign tenant's legacy row is untouched.
    const kept = await prisma.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT count(*)::int AS n FROM "catalog_editorial_states"
      WHERE "tenantId" = ${tenantId} AND "productId" = ${foreign}
        AND "draftRevision" = 3`);
    expect(kept).toEqual([{ n: 1 }]);

    // Every repaired product now reads as V2; a second run has nothing to do.
    for (const productId of [b, c, d]) {
      const response = await request(app.getHttpServer() as Server)
        .get(`/products/${productId}/editorial`)
        .set('Authorization', 'Bearer centro')
        .set('Editorial-Vocabulary-Revision', revision);
      expect(response.status).toBe(200);
    }
    expect(await run(true)).toMatchObject({ slotsCleared: 0, rowsMatched: 3 });
  });
});
