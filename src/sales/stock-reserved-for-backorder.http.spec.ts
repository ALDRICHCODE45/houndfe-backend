/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- supertest bodies and expect matchers are untyped */
/**
 * restock-backorder / T5b — HTTP contract of the counter confirm
 * (POST /sales/drafts/:id/charge): STOCK_RESERVED_FOR_BACKORDER is a 409 with
 * the same envelope as STOCK_INSUFFICIENT_AT_CONFIRM plus {available, reserved}
 * at the root of the body.
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BusinessRuleViolationError } from '../shared/domain/domain-error';
import { DomainExceptionFilter } from '../shared/filters/domain-exception.filter';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { StockReservedForBackorderError } from './stock-reserved-for-backorder.error';

const SALE = '10000000-0000-4000-8000-000000000001';

describe('POST /sales/drafts/:id/charge — stock reserved for a backorder', () => {
  let app: INestApplication;
  const chargeDraft = jest.fn();

  beforeAll(async () => {
    const allow = {
      canActivate: (context: {
        switchToHttp: () => { getRequest: () => Record<string, unknown> };
      }) => {
        context.switchToHttp().getRequest().user = {
          userId: 'user-1',
          email: 'u@test.com',
          tenantId: 'tenant-1',
          tenantSlug: 't',
          isSuperAdmin: false,
        };
        return true;
      },
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [SalesController],
      providers: [{ provide: SalesService, useValue: { chargeDraft } }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(allow)
      .overrideGuard(TenantContextGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    // The real app registers the shared filter globally (main.ts).
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const charge = () =>
    request(app.getHttpServer())
      .post(`/sales/drafts/${SALE}/charge`)
      .set('idempotency-key', 'key-1')
      .send({});

  it('answers 409 STOCK_RESERVED_FOR_BACKORDER with {available, reserved} at the root', async () => {
    chargeDraft.mockRejectedValueOnce(new StockReservedForBackorderError(1, 4));

    const response = await charge();

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      statusCode: 409,
      error: 'STOCK_RESERVED_FOR_BACKORDER',
      message: 'STOCK_RESERVED_FOR_BACKORDER',
      timestamp: expect.any(String),
      available: 1,
      reserved: 4,
    });
  });

  it('leaves the existing plain stock 409 untouched (same envelope, no extra fields)', async () => {
    chargeDraft.mockRejectedValueOnce(
      new BusinessRuleViolationError(
        'STOCK_INSUFFICIENT_AT_CONFIRM',
        'STOCK_INSUFFICIENT_AT_CONFIRM',
      ),
    );

    const response = await charge();

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      statusCode: 409,
      error: 'STOCK_INSUFFICIENT_AT_CONFIRM',
      message: 'STOCK_INSUFFICIENT_AT_CONFIRM',
      timestamp: expect.any(String),
    });
  });
});
