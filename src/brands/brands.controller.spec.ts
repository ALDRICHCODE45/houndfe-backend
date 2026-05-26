import {
  ForbiddenException,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
  type CanActivate,
  type ExecutionContext,
  type Type,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { BrandsController } from './brands.controller';
import { BrandsService } from './brands.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';

function makeMockBrandsService() {
  return {
    create: jest.fn().mockResolvedValue({ id: 'brand-1', name: 'Nike' }),
    findAll: jest.fn().mockResolvedValue([{ id: 'brand-1', name: 'Nike' }]),
    findOne: jest.fn().mockResolvedValue({ id: 'brand-1', name: 'Nike' }),
    update: jest.fn().mockResolvedValue({ id: 'brand-1', name: 'Adidas' }),
    remove: jest.fn().mockResolvedValue(undefined),
  } as any;
}

/**
 * Test guard tokens:
 * - 'super-admin'     → manage:all (super admin)
 * - 'brand-full-crud' → Brand:create/read/update/delete
 * - 'brand-read-only' → Brand:read only
 * - 'no-brand-perms'  → authenticated but no Brand permissions
 * - (no header)       → unauthenticated → 401
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

    if (token === 'brand-full-crud') {
      req.user = {
        userId: 'user-mgr',
        tenantId: 'tenant-1',
        tenantSlug: 'centro',
        isSuperAdmin: false,
        permissions: [
          'create:Brand',
          'read:Brand',
          'update:Brand',
          'delete:Brand',
        ],
      };
      return true;
    }

    if (token === 'brand-read-only') {
      req.user = {
        userId: 'user-cashier',
        tenantId: 'tenant-1',
        tenantSlug: 'centro',
        isSuperAdmin: false,
        permissions: ['read:Brand'],
      };
      return true;
    }

    if (token === 'no-brand-perms') {
      req.user = {
        userId: 'user-empty',
        tenantId: 'tenant-1',
        tenantSlug: 'centro',
        isSuperAdmin: false,
        permissions: [],
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

    // Extract required permissions from metadata
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

describe('BrandsController auth integration', () => {
  let app: INestApplication;
  let service: ReturnType<typeof makeMockBrandsService>;

  beforeEach(async () => {
    service = makeMockBrandsService();

    const moduleRef = await Test.createTestingModule({
      controllers: [BrandsController],
      providers: [{ provide: BrandsService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(TestJwtAuthGuard as Type<CanActivate>)
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

  // ---------- 401: Unauthenticated ----------

  it('GET /brands returns 401 without JWT', async () => {
    await request(app.getHttpServer()).get('/brands').expect(401);
  });

  it('POST /brands returns 401 without JWT', async () => {
    await request(app.getHttpServer())
      .post('/brands')
      .send({ name: 'Nike' })
      .expect(401);
  });

  it('DELETE /brands/:id returns 401 without JWT', async () => {
    await request(app.getHttpServer())
      .delete('/brands/b5e2b8fd-bdfd-471f-b687-ec340d578885')
      .expect(401);
  });

  // ---------- 403: No Brand permissions ----------

  it('GET /brands returns 403 when user lacks Brand:read', async () => {
    await request(app.getHttpServer())
      .get('/brands')
      .set('Authorization', 'Bearer no-brand-perms')
      .expect(403);
  });

  it('POST /brands returns 403 when user lacks Brand:create', async () => {
    await request(app.getHttpServer())
      .post('/brands')
      .set('Authorization', 'Bearer no-brand-perms')
      .send({ name: 'Nike' })
      .expect(403);
  });

  it('PATCH /brands/:id returns 403 when user lacks Brand:update', async () => {
    await request(app.getHttpServer())
      .patch('/brands/b5e2b8fd-bdfd-471f-b687-ec340d578885')
      .set('Authorization', 'Bearer no-brand-perms')
      .send({ name: 'Adidas' })
      .expect(403);
  });

  it('DELETE /brands/:id returns 403 when user lacks Brand:delete', async () => {
    await request(app.getHttpServer())
      .delete('/brands/b5e2b8fd-bdfd-471f-b687-ec340d578885')
      .set('Authorization', 'Bearer no-brand-perms')
      .expect(403);
  });

  // ---------- 403: Partial permissions (read-only trying writes) ----------

  it('POST /brands returns 403 for read-only user', async () => {
    await request(app.getHttpServer())
      .post('/brands')
      .set('Authorization', 'Bearer brand-read-only')
      .send({ name: 'Nike' })
      .expect(403);
  });

  it('PATCH /brands/:id returns 403 for read-only user', async () => {
    await request(app.getHttpServer())
      .patch('/brands/b5e2b8fd-bdfd-471f-b687-ec340d578885')
      .set('Authorization', 'Bearer brand-read-only')
      .send({ name: 'Adidas' })
      .expect(403);
  });

  it('DELETE /brands/:id returns 403 for read-only user', async () => {
    await request(app.getHttpServer())
      .delete('/brands/b5e2b8fd-bdfd-471f-b687-ec340d578885')
      .set('Authorization', 'Bearer brand-read-only')
      .expect(403);
  });

  // ---------- 200/201: Proper permissions ----------

  it('GET /brands returns 200 for user with Brand:read', async () => {
    await request(app.getHttpServer())
      .get('/brands')
      .set('Authorization', 'Bearer brand-read-only')
      .expect(200);
  });

  it('GET /brands/:id returns 200 for user with Brand:read', async () => {
    await request(app.getHttpServer())
      .get('/brands/b5e2b8fd-bdfd-471f-b687-ec340d578885')
      .set('Authorization', 'Bearer brand-full-crud')
      .expect(200);
  });

  it('POST /brands returns 201 for user with Brand:create', async () => {
    await request(app.getHttpServer())
      .post('/brands')
      .set('Authorization', 'Bearer brand-full-crud')
      .send({ name: 'Nike' })
      .expect(201);
  });

  // ---------- Super admin ----------

  it('GET /brands returns 200 for super-admin', async () => {
    await request(app.getHttpServer())
      .get('/brands')
      .set('Authorization', 'Bearer super-admin')
      .expect(200);
  });

  it('POST /brands returns 201 for super-admin', async () => {
    await request(app.getHttpServer())
      .post('/brands')
      .set('Authorization', 'Bearer super-admin')
      .send({ name: 'Nike' })
      .expect(201);
  });
});
