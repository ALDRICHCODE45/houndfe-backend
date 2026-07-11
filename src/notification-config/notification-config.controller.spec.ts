/**
 * Slice C.2 — NotificationConfigController HTTP Layer Tests.
 *
 * Mirrors `src/sat-catalog/sat-catalog.controller.spec.ts` exactly:
 *   - JwtAuthGuard / TenantContextGuard / PermissionsGuard are overridden
 *     with in-memory test guards that read the bearer token to derive
 *     identity & permissions. The real guard stack is exercised elsewhere
 *     (e2e/integration); here we prove the controller wires the
 *     `@UseGuards` + `@RequirePermissions` decorators correctly AND that the
 *     service's BadRequestExceptions surface as HTTP 400.
 *
 * Covers spec scenarios in
 * `openspec/changes/low-stock-alerts/specs/notification-config/spec.md`:
 *   - "Existing config returned verbatim" / "Unconfigured tenant returns safe defaults"
 *   - "Tenant isolation on read"            → service.read called (the
 *                                             tenant scoping itself lives
 *                                             in the adapter, proven by B.2)
 *   - "Read requires read:NotificationConfig"
 *   - "Full overwrite succeeds"
 *   - "Unknown action key rejected"         → service throws UNKNOWN_ACTION_KEY
 *   - "Update requires update:NotificationConfig"
 *   - "INVALID_RECIPIENT"                   → service throws for cross-tenant
 *                                             userIds (Slice C.1 carries the
 *                                             CRITICAL fix; this spec proves
 *                                             the controller surfaces it).
 */
import {
  BadRequestException,
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
import { NotificationConfigController } from './notification-config.controller';
import { NotificationConfigService } from './notification-config.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';

/**
 * Test tokens:
 *  - 'super-admin'         → manage:all
 *  - 'notif-config-rw'     → read+update:NotificationConfig
 *  - 'notif-config-read'   → read:NotificationConfig only (no update)
 *  - 'no-notif-perms'      → authenticated but no NotificationConfig grant
 *  - (no header)           → 401
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

    if (token === 'notif-config-rw') {
      req.user = {
        userId: 'user-rw',
        tenantId: 'tenant-1',
        tenantSlug: 'centro',
        isSuperAdmin: false,
        permissions: ['read:NotificationConfig', 'update:NotificationConfig'],
      };
      return true;
    }

    if (token === 'notif-config-read') {
      req.user = {
        userId: 'user-readonly',
        tenantId: 'tenant-1',
        tenantSlug: 'centro',
        isSuperAdmin: false,
        permissions: ['read:NotificationConfig'],
      };
      return true;
    }

    if (token === 'no-notif-perms') {
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

function makeMockService() {
  return {
    read: jest.fn(),
    replace: jest.fn(),
  } as any;
}

describe('NotificationConfigController — auth integration (C.2)', () => {
  let app: INestApplication;
  let service: ReturnType<typeof makeMockService>;

  beforeEach(async () => {
    service = makeMockService();

    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationConfigController],
      providers: [{ provide: NotificationConfigService, useValue: service }],
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

  it('GET /notification-config returns 401 without JWT', async () => {
    await request(app.getHttpServer()).get('/notification-config').expect(401);
  });

  it('PUT /notification-config returns 401 without JWT', async () => {
    await request(app.getHttpServer())
      .put('/notification-config')
      .send({ enabled: true, recipientUserIds: [], enabledActions: [] })
      .expect(401);
  });

  // ───────── 403: missing read:NotificationConfig ─────────

  it('GET /notification-config returns 403 when caller lacks read:NotificationConfig', async () => {
    await request(app.getHttpServer())
      .get('/notification-config')
      .set('Authorization', 'Bearer no-notif-perms')
      .expect(403);
    expect(service.read).not.toHaveBeenCalled();
  });

  // ───────── 200: super-admin read ─────────

  it('GET /notification-config returns 200 for super-admin and forwards to service.read', async () => {
    service.read.mockResolvedValue({
      enabled: false,
      recipients: [],
      enabledActions: [],
    });

    const res = await request(app.getHttpServer())
      .get('/notification-config')
      .set('Authorization', 'Bearer super-admin')
      .expect(200);

    expect(res.body).toEqual({
      enabled: false,
      recipients: [],
      enabledActions: [],
    });
    expect(service.read).toHaveBeenCalledTimes(1);
  });

  // ───────── 200: configured tenant read ─────────

  it('GET /notification-config returns the configured view verbatim', async () => {
    service.read.mockResolvedValue({
      enabled: true,
      recipients: ['u1', 'u2'],
      enabledActions: ['LOW_STOCK'],
    });

    const res = await request(app.getHttpServer())
      .get('/notification-config')
      .set('Authorization', 'Bearer notif-config-read')
      .expect(200);

    expect(res.body).toEqual({
      enabled: true,
      recipients: ['u1', 'u2'],
      enabledActions: ['LOW_STOCK'],
    });
  });

  // ───────── 403: missing update:NotificationConfig ─────────

  it('PUT /notification-config returns 403 when caller lacks update:NotificationConfig', async () => {
    await request(app.getHttpServer())
      .put('/notification-config')
      .set('Authorization', 'Bearer notif-config-read')
      .send({
        enabled: false,
        recipientUserIds: [],
        enabledActions: [],
      })
      .expect(403);
    expect(service.replace).not.toHaveBeenCalled();
  });

  // ───────── 200: full overwrite (update grant) ─────────

  it('PUT /notification-config returns 200 on a valid full overwrite', async () => {
    service.replace.mockResolvedValue({
      enabled: false,
      recipients: ['u2', 'u3'],
      enabledActions: [],
    });

    const res = await request(app.getHttpServer())
      .put('/notification-config')
      .set('Authorization', 'Bearer notif-config-rw')
      .send({
        enabled: false,
        recipientUserIds: ['u2', 'u3'],
        enabledActions: [],
      })
      .expect(200);

    expect(res.body).toEqual({
      enabled: false,
      recipients: ['u2', 'u3'],
      enabledActions: [],
    });
    expect(service.replace).toHaveBeenCalledWith({
      enabled: false,
      recipientUserIds: ['u2', 'u3'],
      enabledActions: [],
    });
  });

  // ───────── 400: UNKNOWN_ACTION_KEY surfaces from service ─────────

  it('PUT /notification-config returns 400 when service throws UNKNOWN_ACTION_KEY', async () => {
    service.replace.mockRejectedValue(
      new BadRequestException({
        error: 'UNKNOWN_ACTION_KEY',
        message: 'Unknown action key: "LEAD_CREATED".',
      }),
    );

    const res = await request(app.getHttpServer())
      .put('/notification-config')
      .set('Authorization', 'Bearer notif-config-rw')
      .send({
        enabled: true,
        recipientUserIds: [],
        enabledActions: ['LEAD_CREATED'],
      })
      .expect(400);

    expect(res.body.error).toBe('UNKNOWN_ACTION_KEY');
  });

  // ───────── 400: INVALID_RECIPIENT surfaces from service (Slice C.1) ─────────

  it('PUT /notification-config returns 400 when service throws INVALID_RECIPIENT (cross-tenant userId)', async () => {
    service.replace.mockRejectedValue(
      new BadRequestException({
        error: 'INVALID_RECIPIENT',
        message:
          'Recipient(s) are not members of the current tenant: uForeign.',
      }),
    );

    const res = await request(app.getHttpServer())
      .put('/notification-config')
      .set('Authorization', 'Bearer notif-config-rw')
      .send({
        enabled: true,
        recipientUserIds: ['u1', 'uForeign'],
        enabledActions: ['LOW_STOCK'],
      })
      .expect(400);

    expect(res.body.error).toBe('INVALID_RECIPIENT');
  });

  // ───────── 400: DTO validation (forbidNonWhitelisted) ─────────

  it('PUT /notification-config returns 400 when the body has an unknown field', async () => {
    await request(app.getHttpServer())
      .put('/notification-config')
      .set('Authorization', 'Bearer notif-config-rw')
      .send({
        enabled: true,
        recipientUserIds: [],
        enabledActions: [],
        foo: 'bar',
      })
      .expect(400);

    expect(service.replace).not.toHaveBeenCalled();
  });

  // ───────── 400: DTO validation — missing field ─────────

  it('PUT /notification-config returns 400 when the body is missing a required field', async () => {
    await request(app.getHttpServer())
      .put('/notification-config')
      .set('Authorization', 'Bearer notif-config-rw')
      .send({ enabled: true })
      .expect(400);

    expect(service.replace).not.toHaveBeenCalled();
  });
});
