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
import { TenantsMembersController } from './tenants-members.controller';
import { TenantsMembershipService } from './tenants-membership.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';

const TENANT_ID = 'b5e2b8fd-bdfd-471f-b687-ec340d578885';
const MEMBERSHIP_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

function makeMockService() {
  return {
    create: jest.fn().mockResolvedValue({ id: MEMBERSHIP_ID, tenantId: TENANT_ID }),
    findByTenant: jest.fn().mockResolvedValue([{ id: MEMBERSHIP_ID }]),
    update: jest.fn().mockResolvedValue({ id: MEMBERSHIP_ID }),
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
        tenantId: TENANT_ID,
        tenantSlug: 'centro',
        isSuperAdmin: true,
        permissions: ['manage:all'],
      };
      return true;
    }

    if (token === 'membership-full-crud') {
      req.user = {
        userId: 'user-mgr',
        tenantId: TENANT_ID,
        tenantSlug: 'centro',
        isSuperAdmin: false,
        permissions: [
          'create:TenantMembership',
          'read:TenantMembership',
          'update:TenantMembership',
          'delete:TenantMembership',
        ],
      };
      return true;
    }

    if (token === 'membership-read-only') {
      req.user = {
        userId: 'user-viewer',
        tenantId: TENANT_ID,
        tenantSlug: 'centro',
        isSuperAdmin: false,
        permissions: ['read:TenantMembership'],
      };
      return true;
    }

    if (token === 'no-membership-perms') {
      req.user = {
        userId: 'user-empty',
        tenantId: TENANT_ID,
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

describe('TenantsMembersController auth integration', () => {
  let app: INestApplication;
  let service: ReturnType<typeof makeMockService>;

  beforeEach(async () => {
    service = makeMockService();

    const moduleRef = await Test.createTestingModule({
      controllers: [TenantsMembersController],
      providers: [{ provide: TenantsMembershipService, useValue: service }],
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

  it('GET /admin/tenants/:tenantId/members returns 401 without JWT', async () => {
    await request(app.getHttpServer())
      .get(`/admin/tenants/${TENANT_ID}/members`)
      .expect(401);
  });

  it('POST /admin/tenants/:tenantId/members returns 401 without JWT', async () => {
    await request(app.getHttpServer())
      .post(`/admin/tenants/${TENANT_ID}/members`)
      .send({ userId: 'user-1', roleId: 'role-1' })
      .expect(401);
  });

  // ---------- 403: No TenantMembership permissions ----------

  it('GET /admin/tenants/:tenantId/members returns 403 without TenantMembership:read', async () => {
    await request(app.getHttpServer())
      .get(`/admin/tenants/${TENANT_ID}/members`)
      .set('Authorization', 'Bearer no-membership-perms')
      .expect(403);
  });

  it('POST /admin/tenants/:tenantId/members returns 403 without TenantMembership:create', async () => {
    await request(app.getHttpServer())
      .post(`/admin/tenants/${TENANT_ID}/members`)
      .set('Authorization', 'Bearer no-membership-perms')
      .send({ userId: 'user-1', roleId: 'role-1' })
      .expect(403);
  });

  it('PATCH /admin/tenants/:tenantId/members/:id returns 403 without TenantMembership:update', async () => {
    await request(app.getHttpServer())
      .patch(`/admin/tenants/${TENANT_ID}/members/${MEMBERSHIP_ID}`)
      .set('Authorization', 'Bearer no-membership-perms')
      .send({ roleId: 'role-2' })
      .expect(403);
  });

  it('DELETE /admin/tenants/:tenantId/members/:id returns 403 without TenantMembership:delete', async () => {
    await request(app.getHttpServer())
      .delete(`/admin/tenants/${TENANT_ID}/members/${MEMBERSHIP_ID}`)
      .set('Authorization', 'Bearer no-membership-perms')
      .expect(403);
  });

  // ---------- 403: Read-only trying writes ----------

  it('POST returns 403 for read-only user', async () => {
    await request(app.getHttpServer())
      .post(`/admin/tenants/${TENANT_ID}/members`)
      .set('Authorization', 'Bearer membership-read-only')
      .send({ userId: 'user-1', roleId: 'role-1' })
      .expect(403);
  });

  it('DELETE returns 403 for read-only user', async () => {
    await request(app.getHttpServer())
      .delete(`/admin/tenants/${TENANT_ID}/members/${MEMBERSHIP_ID}`)
      .set('Authorization', 'Bearer membership-read-only')
      .expect(403);
  });

  // ---------- 200/201: Proper permissions ----------

  it('GET /admin/tenants/:tenantId/members returns 200 with TenantMembership:read', async () => {
    await request(app.getHttpServer())
      .get(`/admin/tenants/${TENANT_ID}/members`)
      .set('Authorization', 'Bearer membership-read-only')
      .expect(200);
  });

  it('POST returns 201 with TenantMembership:create', async () => {
    await request(app.getHttpServer())
      .post(`/admin/tenants/${TENANT_ID}/members`)
      .set('Authorization', 'Bearer membership-full-crud')
      .send({ userId: 'c1d2e3f4-a5b6-7890-abcd-ef1234567890', roleId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
      .expect(201);
  });

  // ---------- Super admin ----------

  it('GET returns 200 for super-admin', async () => {
    await request(app.getHttpServer())
      .get(`/admin/tenants/${TENANT_ID}/members`)
      .set('Authorization', 'Bearer super-admin')
      .expect(200);
  });

  it('DELETE returns 204 for super-admin', async () => {
    await request(app.getHttpServer())
      .delete(`/admin/tenants/${TENANT_ID}/members/${MEMBERSHIP_ID}`)
      .set('Authorization', 'Bearer super-admin')
      .expect(204);
  });
});
