/**
 * Slice C — SatCatalogController HTTP Layer Tests.
 *
 * Covers spec scenarios in tasks C.3.1–C.3.5:
 *   - GET /sat-keys  → 403 without `read:SatKey`, 200 with it
 *   - Manager role → 200 (W4 anchor — proves the seed grant allows the
 *     realistic product-editor caller; without it Managers 403)
 *   - `?limit=200` → 400 (W2 anchor — global ValidationPipe uses the DTO)
 *   - GET /sat-keys/:key → 404 on miss, 200 on ACTIVE AND retired hits
 *
 * Mirrors the established `src/products/products.controller.spec.ts`
 * pattern: replace JwtAuthGuard/PermissionsGuard/TenantContextGuard with
 * in-memory test guards that read the bearer token to derive the user
 * identity & permissions. Validates the stack end-to-end without booting
 * the auth subsystem.
 */
import {
  ForbiddenException,
  INestApplication,
  NotFoundException,
  UnauthorizedException,
  ValidationPipe,
  type CanActivate,
  type ExecutionContext,
  type Type,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { SatCatalogController } from './sat-catalog.controller';
import { SatCatalogService } from './sat-catalog.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';

function makeMockService() {
  return {
    search: jest.fn(),
    findByKey: jest.fn(),
    assertExists: jest.fn(),
  } as any;
}

/**
 * Test tokens:
 * - 'super-admin'      → manage:all (super admin — bypasses CASL)
 * - 'manager'          → Manager real-world role (perms include 'read:SatKey')
 * - 'sat-key-read'     → read:SatKey only (non-Manager, proves union works
 *                        with the decorator at the per-subject level)
 * - 'no-sat-perms'     → authenticated but no SatKey permission
 * - (no header)        → unauthenticated → 401
 */
class TestJwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const auth = req.headers.authorization as string | undefined;
    if (!auth) throw new UnauthorizedException('Unauthorized');

    const token = auth.replace('Bearer ', '');

    if (token === 'super-admin') {
      req.user = {
        userId: 'user-sa',
        tenantId: null,
        tenantSlug: null,
        isSuperAdmin: true,
        permissions: ['manage:all'],
      };
      return true;
    }

    if (token === 'manager') {
      // Real Manager grant per `prisma/seed.ts`. `read:SatKey` MUST be in
      // this list (Slice C W4) — if missing, the W4 anchor test below
      // fails with 403.
      req.user = {
        userId: 'user-mgr',
        tenantId: 'tenant-1',
        tenantSlug: 'centro',
        isSuperAdmin: false,
        permissions: ['read:SatKey', 'read:Product', 'update:Product'],
      };
      return true;
    }

    if (token === 'sat-key-read') {
      req.user = {
        userId: 'user-readonly',
        tenantId: 'tenant-1',
        tenantSlug: 'centro',
        isSuperAdmin: false,
        permissions: ['read:SatKey'],
      };
      return true;
    }

    if (token === 'no-sat-perms') {
      req.user = {
        userId: 'user-empty',
        tenantId: 'tenant-1',
        tenantSlug: 'centro',
        isSuperAdmin: false,
        permissions: ['read:Product'],
      };
      return true;
    }

    throw new UnauthorizedException('Unauthorized');
  }
}

class TestPermissionsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const permissions = (req.user?.permissions ?? []) as string[];

    // Super admin bypass
    if (permissions.includes('manage:all')) return true;

    const handler = context.getHandler();
    const classRef = context.getClass();
    const requiredPerms =
      Reflect.getMetadata('required_permissions', handler) ??
      Reflect.getMetadata('required_permissions', classRef) ??
      [];

    for (const [action, subject] of requiredPerms) {
      const key = `${action}:${subject}`;
      if (!permissions.includes(key)) {
        throw new ForbiddenException('Insufficient permissions');
      }
    }
    return true;
  }
}

class TestTenantContextGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

describe('SatCatalogController auth integration (Slice C.3)', () => {
  let app: INestApplication;
  let service: ReturnType<typeof makeMockService>;

  beforeEach(async () => {
    service = makeMockService();

    const moduleRef = await Test.createTestingModule({
      controllers: [SatCatalogController],
      providers: [{ provide: SatCatalogService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(TestJwtAuthGuard as Type<CanActivate>)
      .overrideGuard(TenantContextGuard)
      .useClass(TestTenantContextGuard as Type<CanActivate>)
      .overrideGuard(PermissionsGuard)
      .useClass(TestPermissionsGuard as Type<CanActivate>)
      .compile();

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

  // ───────── 401: Unauthenticated ─────────

  it('GET /sat-keys returns 401 without JWT', async () => {
    await request(app.getHttpServer()).get('/sat-keys').expect(401);
  });

  it('GET /sat-keys/:key returns 401 without JWT', async () => {
    await request(app.getHttpServer()).get('/sat-keys/01010101').expect(401);
  });

  // ───────── 403: lacks read:SatKey ─────────

  it('GET /sat-keys returns 403 when user lacks read:SatKey', async () => {
    await request(app.getHttpServer())
      .get('/sat-keys')
      .set('Authorization', 'Bearer no-sat-perms')
      .expect(403);
  });

  it('GET /sat-keys/:key returns 403 when user lacks read:SatKey', async () => {
    await request(app.getHttpServer())
      .get('/sat-keys/01010101')
      .set('Authorization', 'Bearer no-sat-perms')
      .expect(403);
  });

  // ───────── 200: super-admin bypass ─────────

  it('GET /sat-keys returns 200 for super-admin', async () => {
    service.search.mockResolvedValue({
      items: [],
      limit: 20,
      offset: 0,
      total: 0,
    });

    await request(app.getHttpServer())
      .get('/sat-keys')
      .set('Authorization', 'Bearer super-admin')
      .expect(200);

    expect(service.search).toHaveBeenCalledWith('', { limit: 20, offset: 0 });
  });

  // ───────── 200: dedicated read-only user ─────────

  it('GET /sat-keys returns 200 for user with read:SatKey', async () => {
    const fake = {
      key: '01010101',
      description: 'Aspirina',
      includeIva: 'REQUIRED',
      includeIeps: 'NONE',
      validFrom: null,
      validTo: null,
    };
    service.search.mockResolvedValue({
      items: [fake],
      limit: 20,
      offset: 0,
      total: 1,
    });

    const res = await request(app.getHttpServer())
      .get('/sat-keys?search=Aspirina')
      .set('Authorization', 'Bearer sat-key-read')
      .expect(200);

    expect(res.body).toMatchObject({
      limit: 20,
      offset: 0,
      total: 1,
      items: [fake],
    });
    expect(service.search).toHaveBeenCalledWith('Aspirina', {
      limit: 20,
      offset: 0,
    });
  });

  // ───────── W4 ANCHOR: Manager gets 200 ─────────
  // The Manager is the realistic product-editor caller. Without the W4
  // grant in `prisma/seed.ts` (and its CASL union member), this 403s —
  // PROVES Slice C.4 landed.

  it('GET /sat-keys returns 200 for the Manager role (W4 anchor)', async () => {
    service.search.mockResolvedValue({
      items: [],
      limit: 20,
      offset: 0,
      total: 0,
    });

    await request(app.getHttpServer())
      .get('/sat-keys?search=aspirina')
      .set('Authorization', 'Bearer manager')
      .expect(200);
  });

  // ───────── W2 ANCHOR: limit=200 is rejected (400) ─────────
  // The global ValidationPipe translates the DTO constraint failure into
  // 400 BadRequestException.

  it('GET /sat-keys?limit=200 returns 400 (W2 anchor)', async () => {
    await request(app.getHttpServer())
      .get('/sat-keys?limit=200')
      .set('Authorization', 'Bearer super-admin')
      .expect(400);
  });

  // ───────── /:key routes ─────────

  it('GET /sat-keys/:key returns 404 when the key is missing', async () => {
    service.findByKey.mockResolvedValue(null);

    await request(app.getHttpServer())
      .get('/sat-keys/99999999')
      .set('Authorization', 'Bearer super-admin')
      .expect(404);
  });

  it('GET /sat-keys/:key returns 200 on an ACTIVE hit', async () => {
    const active = {
      key: '01010101',
      description: 'Aspirina',
      includeIva: 'REQUIRED',
      includeIeps: 'NONE',
      validFrom: new Date('2024-01-01'),
      validTo: null,
    };
    service.findByKey.mockResolvedValue(active);

    await request(app.getHttpServer())
      .get('/sat-keys/01010101')
      .set('Authorization', 'Bearer super-admin')
      .expect(200);
  });

  it('GET /sat-keys/:key returns 200 on a RETIRED hit (legacy keys resolve)', async () => {
    const retired = {
      key: '01010101',
      description: 'Aspirina (retirada)',
      includeIva: 'NONE',
      includeIeps: 'NONE',
      validFrom: new Date('2010-01-01'),
      validTo: new Date('2020-12-31'),
    };
    service.findByKey.mockResolvedValue(retired);

    await request(app.getHttpServer())
      .get('/sat-keys/01010101')
      .set('Authorization', 'Bearer super-admin')
      .expect(200);
  });
});
