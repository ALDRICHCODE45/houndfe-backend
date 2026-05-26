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
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';

function makeMockCategoriesService() {
  return {
    create: jest
      .fn()
      .mockResolvedValue({ id: 'cat-1', name: 'Electronics' }),
    findAll: jest
      .fn()
      .mockResolvedValue([{ id: 'cat-1', name: 'Electronics' }]),
    findOne: jest
      .fn()
      .mockResolvedValue({ id: 'cat-1', name: 'Electronics' }),
    update: jest.fn().mockResolvedValue({ id: 'cat-1', name: 'Clothing' }),
    remove: jest.fn().mockResolvedValue(undefined),
  } as any;
}

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

    if (token === 'category-full-crud') {
      req.user = {
        userId: 'user-mgr',
        tenantId: 'tenant-1',
        tenantSlug: 'centro',
        isSuperAdmin: false,
        permissions: [
          'create:Category',
          'read:Category',
          'update:Category',
          'delete:Category',
        ],
      };
      return true;
    }

    if (token === 'category-read-only') {
      req.user = {
        userId: 'user-cashier',
        tenantId: 'tenant-1',
        tenantSlug: 'centro',
        isSuperAdmin: false,
        permissions: ['read:Category'],
      };
      return true;
    }

    if (token === 'no-category-perms') {
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

describe('CategoriesController auth integration', () => {
  let app: INestApplication;
  let service: ReturnType<typeof makeMockCategoriesService>;

  beforeEach(async () => {
    service = makeMockCategoriesService();

    const moduleRef = await Test.createTestingModule({
      controllers: [CategoriesController],
      providers: [{ provide: CategoriesService, useValue: service }],
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

  it('GET /categories returns 401 without JWT', async () => {
    await request(app.getHttpServer()).get('/categories').expect(401);
  });

  it('POST /categories returns 401 without JWT', async () => {
    await request(app.getHttpServer())
      .post('/categories')
      .send({ name: 'Electronics' })
      .expect(401);
  });

  it('DELETE /categories/:id returns 401 without JWT', async () => {
    await request(app.getHttpServer())
      .delete('/categories/b5e2b8fd-bdfd-471f-b687-ec340d578885')
      .expect(401);
  });

  // ---------- 403: No Category permissions ----------

  it('GET /categories returns 403 when user lacks Category:read', async () => {
    await request(app.getHttpServer())
      .get('/categories')
      .set('Authorization', 'Bearer no-category-perms')
      .expect(403);
  });

  it('POST /categories returns 403 when user lacks Category:create', async () => {
    await request(app.getHttpServer())
      .post('/categories')
      .set('Authorization', 'Bearer no-category-perms')
      .send({ name: 'Electronics' })
      .expect(403);
  });

  it('PATCH /categories/:id returns 403 when user lacks Category:update', async () => {
    await request(app.getHttpServer())
      .patch('/categories/b5e2b8fd-bdfd-471f-b687-ec340d578885')
      .set('Authorization', 'Bearer no-category-perms')
      .send({ name: 'Clothing' })
      .expect(403);
  });

  it('DELETE /categories/:id returns 403 when user lacks Category:delete', async () => {
    await request(app.getHttpServer())
      .delete('/categories/b5e2b8fd-bdfd-471f-b687-ec340d578885')
      .set('Authorization', 'Bearer no-category-perms')
      .expect(403);
  });

  // ---------- 403: Partial permissions (read-only trying writes) ----------

  it('POST /categories returns 403 for read-only user', async () => {
    await request(app.getHttpServer())
      .post('/categories')
      .set('Authorization', 'Bearer category-read-only')
      .send({ name: 'Electronics' })
      .expect(403);
  });

  it('PATCH /categories/:id returns 403 for read-only user', async () => {
    await request(app.getHttpServer())
      .patch('/categories/b5e2b8fd-bdfd-471f-b687-ec340d578885')
      .set('Authorization', 'Bearer category-read-only')
      .send({ name: 'Clothing' })
      .expect(403);
  });

  it('DELETE /categories/:id returns 403 for read-only user', async () => {
    await request(app.getHttpServer())
      .delete('/categories/b5e2b8fd-bdfd-471f-b687-ec340d578885')
      .set('Authorization', 'Bearer category-read-only')
      .expect(403);
  });

  // ---------- 200/201: Proper permissions ----------

  it('GET /categories returns 200 for user with Category:read', async () => {
    await request(app.getHttpServer())
      .get('/categories')
      .set('Authorization', 'Bearer category-read-only')
      .expect(200);
  });

  it('GET /categories/:id returns 200 for user with Category:read', async () => {
    await request(app.getHttpServer())
      .get('/categories/b5e2b8fd-bdfd-471f-b687-ec340d578885')
      .set('Authorization', 'Bearer category-full-crud')
      .expect(200);
  });

  it('POST /categories returns 201 for user with Category:create', async () => {
    await request(app.getHttpServer())
      .post('/categories')
      .set('Authorization', 'Bearer category-full-crud')
      .send({ name: 'Electronics' })
      .expect(201);
  });

  // ---------- Super admin ----------

  it('GET /categories returns 200 for super-admin', async () => {
    await request(app.getHttpServer())
      .get('/categories')
      .set('Authorization', 'Bearer super-admin')
      .expect(200);
  });

  it('POST /categories returns 201 for super-admin', async () => {
    await request(app.getHttpServer())
      .post('/categories')
      .set('Authorization', 'Bearer super-admin')
      .send({ name: 'Electronics' })
      .expect(201);
  });
});
