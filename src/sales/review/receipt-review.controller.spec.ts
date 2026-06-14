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
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import type {
  AppActions,
  AppSubjects,
} from '../../auth/authorization/domain/permission';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { ReceiptReviewService } from './receipt-review.service';
import { ReceiptReviewController } from './receipt-review.controller';

type TestRequest = {
  headers: Record<string, string | undefined>;
  user?: AuthenticatedUser & { permissions: string[] };
};

function makeService() {
  return {
    listPending: jest.fn().mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        saleId: '22222222-2222-4222-8222-222222222222',
        mediaUrl: 'https://spaces.test/receipt.jpg',
        declaredAmountCents: 1500,
        declaredDate: new Date('2026-06-13T10:00:00.000Z'),
        declaredReference: 'TRX-1',
        status: 'PENDING',
        salePaymentStatus: 'PARTIAL',
        salePaidCents: 500,
        saleDebtCents: 1500,
        saleTotalCents: 2000,
      },
    ]),
    confirm: jest.fn().mockResolvedValue({
      saleId: '22222222-2222-4222-8222-222222222222',
      paidCents: 2000,
      debtCents: 0,
      totalCents: 2000,
      paymentStatus: 'PAID',
      paymentIds: ['payment-1'],
    }),
    reject: jest.fn().mockResolvedValue(undefined),
  } as jest.Mocked<
    Pick<ReceiptReviewService, 'listPending' | 'confirm' | 'reject'>
  >;
}

class TestJwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<TestRequest>();
    const auth = request.headers.authorization;
    if (!auth) throw new UnauthorizedException('Unauthorized');

    const token = auth.replace('Bearer ', '');
    const permissions =
      token === 'receipt-reviewer'
        ? ['read:ReceiptEvidence', 'update:ReceiptEvidence']
        : [];

    request.user = {
      userId: 'reviewer-1',
      email: 'reviewer@example.com',
      tenantId: 'tenant-1',
      tenantSlug: 'centro',
      isSuperAdmin: false,
      permissions,
    };

    return true;
  }
}

class TestTenantContextGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<TestRequest>();
    if (!request.user?.tenantId) {
      throw new UnauthorizedException('Tenant context required');
    }

    return true;
  }
}

class TestPermissionsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<TestRequest>();
    const permissions = request.user?.permissions ?? [];
    const requiredPermissions = (Reflect.getMetadata(
      'required_permissions',
      context.getHandler(),
    ) ??
      Reflect.getMetadata('required_permissions', context.getClass()) ??
      []) as Array<[AppActions, AppSubjects]>;

    for (const [action, subject] of requiredPermissions) {
      if (!permissions.includes(`${action}:${subject}`)) {
        throw new ForbiddenException('Insufficient permissions');
      }
    }

    return true;
  }
}

describe('ReceiptReviewController', () => {
  let app: INestApplication;
  let service: ReturnType<typeof makeService>;

  beforeEach(async () => {
    service = makeService();

    const moduleRef = await Test.createTestingModule({
      controllers: [ReceiptReviewController],
      providers: [{ provide: ReceiptReviewService, useValue: service }],
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

  it('GET /sales/:id/receipts requires ReceiptEvidence:read and returns the pending queue', async () => {
    const response = await request(app.getHttpServer())
      .get('/sales/22222222-2222-4222-8222-222222222222/receipts')
      .set('Authorization', 'Bearer receipt-reviewer')
      .expect(200);

    expect(service.listPending).toHaveBeenCalledWith(
      '22222222-2222-4222-8222-222222222222',
    );
    expect(response.body).toEqual([
      expect.objectContaining({
        id: '11111111-1111-4111-8111-111111111111',
        mediaUrl: 'https://spaces.test/receipt.jpg',
        status: 'PENDING',
      }),
    ]);
  });

  it('POST /sales/:id/receipts/:rid/confirm requires ReceiptEvidence:update and delegates validated input', async () => {
    await request(app.getHttpServer())
      .post(
        '/sales/22222222-2222-4222-8222-222222222222/receipts/11111111-1111-4111-8111-111111111111/confirm',
      )
      .set('Authorization', 'Bearer receipt-reviewer')
      .set('Idempotency-Key', '  idem-1  ')
      .send({ amountCents: 2000 })
      .expect(200);

    expect(service.confirm).toHaveBeenCalledWith(
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
      'reviewer-1',
      { amountCents: 2000 },
      'idem-1',
    );
  });

  it('POST /sales/:id/receipts/:rid/confirm rejects invalid amounts before delegation', async () => {
    await request(app.getHttpServer())
      .post(
        '/sales/22222222-2222-4222-8222-222222222222/receipts/11111111-1111-4111-8111-111111111111/confirm',
      )
      .set('Authorization', 'Bearer receipt-reviewer')
      .set('Idempotency-Key', 'idem-2')
      .send({ amountCents: 0 })
      .expect(400);

    expect(service.confirm).not.toHaveBeenCalled();
  });

  it('POST /sales/:id/receipts/:rid/reject requires ReceiptEvidence:update and rejects empty reasons', async () => {
    await request(app.getHttpServer())
      .post(
        '/sales/22222222-2222-4222-8222-222222222222/receipts/11111111-1111-4111-8111-111111111111/reject',
      )
      .set('Authorization', 'Bearer receipt-reviewer')
      .send({ reason: '' })
      .expect(400);

    expect(service.reject).not.toHaveBeenCalled();
  });

  it('rejects review actions when the actor lacks ReceiptEvidence permissions', async () => {
    await request(app.getHttpServer())
      .post(
        '/sales/22222222-2222-4222-8222-222222222222/receipts/11111111-1111-4111-8111-111111111111/reject',
      )
      .set('Authorization', 'Bearer no-review-permissions')
      .send({ reason: 'Unreadable receipt' })
      .expect(403);

    expect(service.reject).not.toHaveBeenCalled();
  });
});
