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
import { TenantsController } from './tenants.controller';
import { TenantsMembershipService } from './tenants-membership.service';
import { TenantsService } from './tenants.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';

function makeMockTenantsService() {
  return {
    create: jest
      .fn()
      .mockResolvedValue({ id: 'tenant-1', name: 'Centro', slug: 'centro' }),
    findAll: jest.fn().mockResolvedValue([{ id: 'tenant-1', name: 'Centro' }]),
    findOne: jest.fn().mockResolvedValue({ id: 'tenant-1', name: 'Centro' }),
    findRoles: jest.fn().mockResolvedValue([{ id: 'role-1', name: 'Manager' }]),
    update: jest
      .fn()
      .mockResolvedValue({ id: 'tenant-1', name: 'Centro Updated' }),
    deactivate: jest.fn().mockResolvedValue(undefined),
  } as any;
}

function makeMockTenantsMembershipService() {
  return {
    findEligibleUsers: jest.fn().mockResolvedValue({
      data: [
        {
          id: 'user-eligible-1',
          email: 'eligible@example.com',
          name: 'Eligible User',
          isActive: true,
        },
      ],
      meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
    }),
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

    if (token === 'tenant-full-crud') {
      req.user = {
        userId: 'user-mgr',
        tenantId: 'tenant-1',
        tenantSlug: 'centro',
        isSuperAdmin: false,
        permissions: [
          'create:Tenant',
          'read:Tenant',
          'update:Tenant',
          'delete:Tenant',
        ],
      };
      return true;
    }

    if (token === 'tenant-read-only') {
      req.user = {
        userId: 'user-viewer',
        tenantId: 'tenant-1',
        tenantSlug: 'centro',
        isSuperAdmin: false,
        permissions: ['read:Tenant'],
      };
      return true;
    }

    if (token === 'membership-create-only') {
      req.user = {
        userId: 'user-membership-creator',
        tenantId: 'tenant-1',
        tenantSlug: 'centro',
        isSuperAdmin: false,
        permissions: ['create:TenantMembership'],
      };
      return true;
    }

    if (token === 'no-tenant-perms') {
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

describe('TenantsController auth integration', () => {
  let app: INestApplication;
  let service: ReturnType<typeof makeMockTenantsService>;
  let membershipsService: ReturnType<typeof makeMockTenantsMembershipService>;

  beforeEach(async () => {
    service = makeMockTenantsService();
    membershipsService = makeMockTenantsMembershipService();

    const moduleRef = await Test.createTestingModule({
      controllers: [TenantsController],
      providers: [
        { provide: TenantsService, useValue: service },
        { provide: TenantsMembershipService, useValue: membershipsService },
      ],
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

  it('GET /admin/tenants returns 401 without JWT', async () => {
    await request(app.getHttpServer()).get('/admin/tenants').expect(401);
  });

  it('POST /admin/tenants returns 401 without JWT', async () => {
    await request(app.getHttpServer())
      .post('/admin/tenants')
      .send({ name: 'New', slug: 'new' })
      .expect(401);
  });

  // ---------- 403: No Tenant permissions ----------

  it('GET /admin/tenants returns 403 when user lacks Tenant:read', async () => {
    await request(app.getHttpServer())
      .get('/admin/tenants')
      .set('Authorization', 'Bearer no-tenant-perms')
      .expect(403);
  });

  it('POST /admin/tenants returns 403 when user lacks Tenant:create', async () => {
    await request(app.getHttpServer())
      .post('/admin/tenants')
      .set('Authorization', 'Bearer no-tenant-perms')
      .send({ name: 'New', slug: 'new' })
      .expect(403);
  });

  it('GET /admin/tenants/:id returns 403 when user lacks Tenant:read', async () => {
    await request(app.getHttpServer())
      .get('/admin/tenants/b5e2b8fd-bdfd-471f-b687-ec340d578885')
      .set('Authorization', 'Bearer no-tenant-perms')
      .expect(403);
  });

  it('GET /admin/tenants/:id/roles returns 403 when user lacks Tenant:read', async () => {
    await request(app.getHttpServer())
      .get('/admin/tenants/b5e2b8fd-bdfd-471f-b687-ec340d578885/roles')
      .set('Authorization', 'Bearer no-tenant-perms')
      .expect(403);
  });

  it('PATCH /admin/tenants/:id returns 403 when user lacks Tenant:update', async () => {
    await request(app.getHttpServer())
      .patch('/admin/tenants/b5e2b8fd-bdfd-471f-b687-ec340d578885')
      .set('Authorization', 'Bearer no-tenant-perms')
      .send({ name: 'Updated' })
      .expect(403);
  });

  it('DELETE /admin/tenants/:id returns 403 when user lacks Tenant:delete', async () => {
    await request(app.getHttpServer())
      .delete('/admin/tenants/b5e2b8fd-bdfd-471f-b687-ec340d578885')
      .set('Authorization', 'Bearer no-tenant-perms')
      .expect(403);
  });

  it('GET /admin/tenants/:tenantId/eligible-users returns 403 without TenantMembership:create', async () => {
    await request(app.getHttpServer())
      .get('/admin/tenants/b5e2b8fd-bdfd-471f-b687-ec340d578885/eligible-users')
      .set('Authorization', 'Bearer tenant-read-only')
      .expect(403);
  });

  // ---------- 403: Read-only trying writes ----------

  it('POST /admin/tenants returns 403 for read-only user', async () => {
    await request(app.getHttpServer())
      .post('/admin/tenants')
      .set('Authorization', 'Bearer tenant-read-only')
      .send({ name: 'New', slug: 'new' })
      .expect(403);
  });

  it('PATCH /admin/tenants/:id returns 403 for read-only user', async () => {
    await request(app.getHttpServer())
      .patch('/admin/tenants/b5e2b8fd-bdfd-471f-b687-ec340d578885')
      .set('Authorization', 'Bearer tenant-read-only')
      .send({ name: 'Updated' })
      .expect(403);
  });

  it('DELETE /admin/tenants/:id returns 403 for read-only user', async () => {
    await request(app.getHttpServer())
      .delete('/admin/tenants/b5e2b8fd-bdfd-471f-b687-ec340d578885')
      .set('Authorization', 'Bearer tenant-read-only')
      .expect(403);
  });

  // ---------- 200/201: Proper permissions ----------

  it('GET /admin/tenants returns 200 for user with Tenant:read', async () => {
    await request(app.getHttpServer())
      .get('/admin/tenants')
      .set('Authorization', 'Bearer tenant-read-only')
      .expect(200);
  });

  it('GET /admin/tenants/:id returns 200 for user with Tenant:read', async () => {
    await request(app.getHttpServer())
      .get('/admin/tenants/b5e2b8fd-bdfd-471f-b687-ec340d578885')
      .set('Authorization', 'Bearer tenant-full-crud')
      .expect(200);
  });

  it('GET /admin/tenants/:id/roles returns 200 for user with Tenant:read', async () => {
    await request(app.getHttpServer())
      .get('/admin/tenants/b5e2b8fd-bdfd-471f-b687-ec340d578885/roles')
      .set('Authorization', 'Bearer tenant-full-crud')
      .expect(200);
  });

  it('POST /admin/tenants returns 201 for user with Tenant:create', async () => {
    await request(app.getHttpServer())
      .post('/admin/tenants')
      .set('Authorization', 'Bearer tenant-full-crud')
      .send({ name: 'New Tenant', slug: 'new-tenant' })
      .expect(201);
  });

  it('GET /admin/tenants/:tenantId/eligible-users dispatches query dto and returns {data,meta}', async () => {
    const response = await request(app.getHttpServer())
      .get(
        '/admin/tenants/b5e2b8fd-bdfd-471f-b687-ec340d578885/eligible-users?page=2&limit=10&search=ju&includeInactive=true',
      )
      .set('Authorization', 'Bearer membership-create-only')
      .expect(200);

    expect(membershipsService.findEligibleUsers).toHaveBeenCalledWith(
      'b5e2b8fd-bdfd-471f-b687-ec340d578885',
      {
        search: 'ju',
        page: 2,
        limit: 10,
        includeInactive: true,
      },
    );
    expect(response.body).toEqual({
      data: [
        {
          id: 'user-eligible-1',
          email: 'eligible@example.com',
          name: 'Eligible User',
          isActive: true,
        },
      ],
      meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
    });
  });

  // ---------- Super admin ----------

  it('GET /admin/tenants returns 200 for super-admin', async () => {
    await request(app.getHttpServer())
      .get('/admin/tenants')
      .set('Authorization', 'Bearer super-admin')
      .expect(200);
  });

  it('POST /admin/tenants returns 201 for super-admin', async () => {
    await request(app.getHttpServer())
      .post('/admin/tenants')
      .set('Authorization', 'Bearer super-admin')
      .send({ name: 'New Tenant', slug: 'new-tenant' })
      .expect(201);
  });

  it('DELETE /admin/tenants/:id returns 204 for super-admin', async () => {
    await request(app.getHttpServer())
      .delete('/admin/tenants/b5e2b8fd-bdfd-471f-b687-ec340d578885')
      .set('Authorization', 'Bearer super-admin')
      .expect(204);
  });
});
