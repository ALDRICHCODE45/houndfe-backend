/**
 * EmployeeTimeOffController auth integration — 403 permission coverage.
 *
 * The controller is guarded by
 * `@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)` and
 * every endpoint carries `@RequirePermissions([...])`. This spec proves
 * each route is fenced by its declared permission tuple.
 *
 * APPROACH — supertest + a NestJS testing module with guard overrides
 * (mirrors the established `products.controller.spec.ts` /
 * `categories.controller.spec.ts` pattern): a stand-in `JwtAuthGuard`
 * injects a `req.user` whose `permissions[]` model the CASL ability,
 * and a stand-in `PermissionsGuard` reads the SAME `required_permissions`
 * metadata the production guard reads (via `Reflect.getMetadata`) and
 * throws `ForbiddenException` (403) when the permission is absent. The
 * `TenantContextGuard` is stubbed to a pass-through — this spec isolates
 * the permission fence, not tenant resolution.
 *
 * Coverage:
 *   - 403 for EACH of the 6 endpoints when the user lacks the required
 *     permission (empty perms).
 *   - 403 for the write endpoints when a read-only user attempts them.
 *   - Positive cases (200/201) proving the guard actually READS the
 *     metadata and ALLOWS when the permission is present.
 *   - 401 when unauthenticated (guard chain smoke).
 */
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
import { EmployeeTimeOffController } from './employee-time-off.controller';
import { EmployeeTimeOffService } from './application/employee-time-off.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';

// Valid UUIDs — the route params are behind `ParseUUIDPipe`, so the
// positive paths need well-formed ids. Guards run BEFORE pipes, so the
// 403 paths don't depend on these, but we keep them valid throughout.
const EMPLOYEE_ID = 'b5e2b8fd-bdfd-471f-b687-ec340d578885';
const TIME_OFF_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

function makeMockTimeOffService() {
  return {
    request: jest.fn().mockResolvedValue({ id: TIME_OFF_ID, status: 'PENDING' }),
    listForEmployee: jest
      .fn()
      .mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 }),
    getVacationBalance: jest.fn().mockResolvedValue({
      year: 2026,
      entitlement: 15,
      used: 0,
      pending: 0,
      remaining: 15,
    }),
    review: jest
      .fn()
      .mockResolvedValue({ id: TIME_OFF_ID, status: 'APPROVED' }),
    cancel: jest
      .fn()
      .mockResolvedValue({ id: TIME_OFF_ID, status: 'CANCELLED' }),
    listPendingApprovals: jest.fn().mockResolvedValue([]),
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

    if (token === 'timeoff-full-crud') {
      req.user = {
        userId: 'user-mgr',
        tenantId: 'tenant-1',
        tenantSlug: 'centro',
        isSuperAdmin: false,
        permissions: [
          'create:EmployeeTimeOff',
          'read:EmployeeTimeOff',
          'update:EmployeeTimeOff',
        ],
      };
      return true;
    }

    if (token === 'timeoff-read-only') {
      req.user = {
        userId: 'user-cashier',
        tenantId: 'tenant-1',
        tenantSlug: 'centro',
        isSuperAdmin: false,
        permissions: ['read:EmployeeTimeOff'],
      };
      return true;
    }

    if (token === 'no-timeoff-perms') {
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

    // Super admin bypass.
    if (permissions.includes('manage:all')) return true;

    // Read the SAME metadata key the production PermissionsGuard reads.
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

describe('EmployeeTimeOffController auth integration', () => {
  let app: INestApplication;
  let service: ReturnType<typeof makeMockTimeOffService>;

  beforeEach(async () => {
    service = makeMockTimeOffService();

    const moduleRef = await Test.createTestingModule({
      controllers: [EmployeeTimeOffController],
      providers: [{ provide: EmployeeTimeOffService, useValue: service }],
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

  // ---------- 401: Unauthenticated (guard chain smoke) ----------

  it('GET pending-approvals returns 401 without JWT', async () => {
    await request(app.getHttpServer())
      .get('/admin/employees-time-off/pending-approvals')
      .expect(401);
  });

  it('POST time-off returns 401 without JWT', async () => {
    await request(app.getHttpServer())
      .post(`/admin/employees/${EMPLOYEE_ID}/time-off`)
      .send({
        type: 'VACATION',
        startDate: '2026-07-01T00:00:00.000Z',
        endDate: '2026-07-05T00:00:00.000Z',
      })
      .expect(401);
  });

  // ---------- 403: user with NO EmployeeTimeOff permissions ----------

  it('POST time-off → 403 when user lacks create:EmployeeTimeOff', async () => {
    await request(app.getHttpServer())
      .post(`/admin/employees/${EMPLOYEE_ID}/time-off`)
      .set('Authorization', 'Bearer no-timeoff-perms')
      .send({
        type: 'VACATION',
        startDate: '2026-07-01T00:00:00.000Z',
        endDate: '2026-07-05T00:00:00.000Z',
      })
      .expect(403);
  });

  it('GET time-off (list) → 403 when user lacks read:EmployeeTimeOff', async () => {
    await request(app.getHttpServer())
      .get(`/admin/employees/${EMPLOYEE_ID}/time-off`)
      .set('Authorization', 'Bearer no-timeoff-perms')
      .expect(403);
  });

  it('GET vacation-balance → 403 when user lacks read:EmployeeTimeOff', async () => {
    await request(app.getHttpServer())
      .get(`/admin/employees/${EMPLOYEE_ID}/time-off/vacation-balance`)
      .set('Authorization', 'Bearer no-timeoff-perms')
      .expect(403);
  });

  it('POST review → 403 when user lacks update:EmployeeTimeOff', async () => {
    await request(app.getHttpServer())
      .post(`/admin/employees/${EMPLOYEE_ID}/time-off/${TIME_OFF_ID}/review`)
      .set('Authorization', 'Bearer no-timeoff-perms')
      .send({ decision: 'APPROVED' })
      .expect(403);
  });

  it('POST cancel → 403 when user lacks update:EmployeeTimeOff', async () => {
    await request(app.getHttpServer())
      .post(`/admin/employees/${EMPLOYEE_ID}/time-off/${TIME_OFF_ID}/cancel`)
      .set('Authorization', 'Bearer no-timeoff-perms')
      .expect(403);
  });

  it('GET pending-approvals → 403 when user lacks read:EmployeeTimeOff', async () => {
    await request(app.getHttpServer())
      .get('/admin/employees-time-off/pending-approvals')
      .set('Authorization', 'Bearer no-timeoff-perms')
      .expect(403);
  });

  // ---------- 403: read-only user attempting write endpoints ----------

  it('POST time-off → 403 for read-only user (needs create)', async () => {
    await request(app.getHttpServer())
      .post(`/admin/employees/${EMPLOYEE_ID}/time-off`)
      .set('Authorization', 'Bearer timeoff-read-only')
      .send({
        type: 'VACATION',
        startDate: '2026-07-01T00:00:00.000Z',
        endDate: '2026-07-05T00:00:00.000Z',
      })
      .expect(403);
  });

  it('POST review → 403 for read-only user (needs update)', async () => {
    await request(app.getHttpServer())
      .post(`/admin/employees/${EMPLOYEE_ID}/time-off/${TIME_OFF_ID}/review`)
      .set('Authorization', 'Bearer timeoff-read-only')
      .send({ decision: 'APPROVED' })
      .expect(403);
  });

  it('POST cancel → 403 for read-only user (needs update)', async () => {
    await request(app.getHttpServer())
      .post(`/admin/employees/${EMPLOYEE_ID}/time-off/${TIME_OFF_ID}/cancel`)
      .set('Authorization', 'Bearer timeoff-read-only')
      .expect(403);
  });

  // ---------- Positive: guard READS metadata and ALLOWS when present ----------

  it('GET time-off (list) → 200 for read-only user (has read)', async () => {
    await request(app.getHttpServer())
      .get(`/admin/employees/${EMPLOYEE_ID}/time-off`)
      .set('Authorization', 'Bearer timeoff-read-only')
      .expect(200);
    expect(service.listForEmployee).toHaveBeenCalledTimes(1);
  });

  it('GET pending-approvals → 200 for read-only user (has read)', async () => {
    await request(app.getHttpServer())
      .get('/admin/employees-time-off/pending-approvals')
      .set('Authorization', 'Bearer timeoff-read-only')
      .expect(200);
    expect(service.listPendingApprovals).toHaveBeenCalledTimes(1);
  });

  it('POST time-off → 201 for full-CRUD user (has create)', async () => {
    await request(app.getHttpServer())
      .post(`/admin/employees/${EMPLOYEE_ID}/time-off`)
      .set('Authorization', 'Bearer timeoff-full-crud')
      .send({
        type: 'VACATION',
        startDate: '2026-07-01T00:00:00.000Z',
        endDate: '2026-07-05T00:00:00.000Z',
      })
      .expect(201);
    expect(service.request).toHaveBeenCalledTimes(1);
  });

  it('POST review → 201 for full-CRUD user (has update)', async () => {
    // `review` is a @Post with no @HttpCode override → NestJS default 201.
    // (Only `cancel` declares @HttpCode(HttpStatus.OK).)
    await request(app.getHttpServer())
      .post(`/admin/employees/${EMPLOYEE_ID}/time-off/${TIME_OFF_ID}/review`)
      .set('Authorization', 'Bearer timeoff-full-crud')
      .send({ decision: 'APPROVED' })
      .expect(201);
    expect(service.review).toHaveBeenCalledTimes(1);
  });

  it('GET pending-approvals → 200 for super-admin (manage:all bypass)', async () => {
    await request(app.getHttpServer())
      .get('/admin/employees-time-off/pending-approvals')
      .set('Authorization', 'Bearer super-admin')
      .expect(200);
  });
});
