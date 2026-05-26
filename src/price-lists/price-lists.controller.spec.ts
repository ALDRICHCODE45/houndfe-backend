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
import { PriceListsController } from './price-lists.controller';
import { PriceListsService } from './price-lists.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';

function makeMockService() {
  return {
    findAll: jest.fn().mockResolvedValue([{ id: 'pl-1', name: 'PUBLICO' }]),
    create: jest.fn().mockResolvedValue({ id: 'pl-2', name: 'MAYOREO' }),
    update: jest.fn().mockResolvedValue({ id: 'pl-1', name: 'Updated' }),
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
        tenantId: 'tenant-1',
        tenantSlug: 'centro',
        isSuperAdmin: true,
        permissions: ['manage:all'],
      };
      return true;
    }

    if (token === 'pricelist-read-only') {
      req.user = {
        userId: 'user-mgr',
        tenantId: 'tenant-1',
        tenantSlug: 'centro',
        isSuperAdmin: false,
        permissions: ['read:GlobalPriceList'],
      };
      return true;
    }

    if (token === 'no-pricelist-perms') {
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

class TestTenantContextGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (!req.user?.tenantId) {
      throw new UnauthorizedException('Tenant context required');
    }
    return true;
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

describe('PriceListsController auth integration', () => {
  let app: INestApplication;
  let service: ReturnType<typeof makeMockService>;

  beforeEach(async () => {
    service = makeMockService();

    const moduleRef = await Test.createTestingModule({
      controllers: [PriceListsController],
      providers: [{ provide: PriceListsService, useValue: service }],
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

  // ---------- 401: Unauthenticated ----------

  it('GET /price-lists returns 401 without JWT', async () => {
    await request(app.getHttpServer()).get('/price-lists').expect(401);
  });

  it('POST /price-lists returns 401 without JWT', async () => {
    await request(app.getHttpServer())
      .post('/price-lists')
      .send({ name: 'MAYOREO' })
      .expect(401);
  });

  // ---------- 403: No permissions ----------

  it('GET /price-lists returns 403 without GlobalPriceList:read', async () => {
    await request(app.getHttpServer())
      .get('/price-lists')
      .set('Authorization', 'Bearer no-pricelist-perms')
      .expect(403);
  });

  it('POST /price-lists returns 403 without GlobalPriceList:create', async () => {
    await request(app.getHttpServer())
      .post('/price-lists')
      .set('Authorization', 'Bearer no-pricelist-perms')
      .send({ name: 'MAYOREO' })
      .expect(403);
  });

  it('PATCH /price-lists/:id returns 403 without GlobalPriceList:update', async () => {
    await request(app.getHttpServer())
      .patch('/price-lists/b5e2b8fd-bdfd-471f-b687-ec340d578885')
      .set('Authorization', 'Bearer no-pricelist-perms')
      .send({ name: 'Updated' })
      .expect(403);
  });

  it('DELETE /price-lists/:id returns 403 without GlobalPriceList:delete', async () => {
    await request(app.getHttpServer())
      .delete('/price-lists/b5e2b8fd-bdfd-471f-b687-ec340d578885')
      .set('Authorization', 'Bearer no-pricelist-perms')
      .expect(403);
  });

  // ---------- 403: Manager (read-only) cannot write ----------

  it('POST /price-lists returns 403 for manager with only GlobalPriceList:read', async () => {
    await request(app.getHttpServer())
      .post('/price-lists')
      .set('Authorization', 'Bearer pricelist-read-only')
      .send({ name: 'MAYOREO' })
      .expect(403);
  });

  it('PATCH /price-lists/:id returns 403 for manager with only GlobalPriceList:read', async () => {
    await request(app.getHttpServer())
      .patch('/price-lists/b5e2b8fd-bdfd-471f-b687-ec340d578885')
      .set('Authorization', 'Bearer pricelist-read-only')
      .send({ name: 'Updated' })
      .expect(403);
  });

  it('DELETE /price-lists/:id returns 403 for manager with only GlobalPriceList:read', async () => {
    await request(app.getHttpServer())
      .delete('/price-lists/b5e2b8fd-bdfd-471f-b687-ec340d578885')
      .set('Authorization', 'Bearer pricelist-read-only')
      .expect(403);
  });

  // ---------- 200: Proper read permissions ----------

  it('GET /price-lists returns 200 with GlobalPriceList:read', async () => {
    await request(app.getHttpServer())
      .get('/price-lists')
      .set('Authorization', 'Bearer pricelist-read-only')
      .expect(200);
  });

  // ---------- Super admin ----------

  it('GET /price-lists returns 200 for super-admin', async () => {
    await request(app.getHttpServer())
      .get('/price-lists')
      .set('Authorization', 'Bearer super-admin')
      .expect(200);
  });

  it('POST /price-lists returns 201 for super-admin', async () => {
    await request(app.getHttpServer())
      .post('/price-lists')
      .set('Authorization', 'Bearer super-admin')
      .send({ name: 'MAYOREO' })
      .expect(201);
  });

  it('DELETE /price-lists/:id returns 204 for super-admin', async () => {
    await request(app.getHttpServer())
      .delete('/price-lists/b5e2b8fd-bdfd-471f-b687-ec340d578885')
      .set('Authorization', 'Bearer super-admin')
      .expect(204);
  });
});
