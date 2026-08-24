/**
 * Q1 / WU1 — AdminPaymentDetailController spec.
 *
 * Covers:
 *   - `@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)` is
 *     applied at the class level.
 *   - `@RequirePermissions(['<action>', 'PaymentDetail'])` is set per route
 *     (verified via the metadata reflection helper `getAllAndOverride`).
 *   - 201 on POST, 204 on DELETE.
 *   - 400 on invalid DTO (CLABE non-18-digit).
 *   - 409 on DUPLICATE_CLABE.
 *   - The `delete` route propagates 404 from the service.
 *
 * Run via `pnpm test src/admin/payment-details/admin-payment-detail.controller.spec.ts`.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import request from 'supertest';
import { ClsService } from 'nestjs-cls';
import { AdminPaymentDetailController } from './admin-payment-detail.controller';
import { AdminPaymentDetailService } from './admin-payment-detail.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { PERMISSIONS_KEY } from '../../auth/authorization/decorators/require-permissions.decorator';
import { DomainExceptionFilter } from '../../shared/filters/domain-exception.filter';
import {
  BusinessRuleViolationError,
  EntityNotFoundError,
} from '../../shared/domain/domain-error';

describe('AdminPaymentDetailController', () => {
  let app: INestApplication;
  let service: {
    findAll: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      findAll: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue({
        id: '11111111-1111-4111-8111-111111111111',
        tenantId: 'tenant-1',
        bankName: 'BBVA',
        beneficiary: 'Tienda XYZ',
        clabe: '012345678901234567',
        accountNumber: '1234567890',
        isActive: true,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z',
      }),
      create: jest.fn().mockResolvedValue({
        id: '11111111-1111-4111-8111-111111111111',
        tenantId: 'tenant-1',
        bankName: 'BBVA',
        beneficiary: 'Tienda XYZ',
        clabe: '012345678901234567',
        accountNumber: '1234567890',
        isActive: true,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z',
      }),
      update: jest.fn().mockResolvedValue({
        id: '11111111-1111-4111-8111-111111111111',
        tenantId: 'tenant-1',
        bankName: 'BBVA',
        beneficiary: 'Nuevo Beneficiario',
        clabe: '012345678901234567',
        accountNumber: '1234567890',
        isActive: true,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      }),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    // Stub guards so we can hit the controller without setting up the full
    // auth chain — we trust the JwtAuthGuard / TenantContextGuard /
    // PermissionsGuard specs to cover their own behavior.
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminPaymentDetailController],
      providers: [{ provide: AdminPaymentDetailService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(TenantContextGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  function httpServer(): Parameters<typeof request>[0] {
    return app.getHttpServer() as Parameters<typeof request>[0];
  }

  describe('@RequirePermissions wiring', () => {
    let reflector: Reflector;

    beforeEach(() => {
      reflector = app.get(Reflector);
    });

    it('declares class-level guards via @UseGuards', () => {
      const guards = reflector.getAllAndOverride('__guards__', [
        AdminPaymentDetailController,
        undefined,
      ]);
      expect(guards).toBeDefined();
      // The metadata is the constructor function for each guard.
      expect(guards).toHaveLength(3);
      expect(guards).toContain(JwtAuthGuard);
      expect(guards).toContain(TenantContextGuard);
      expect(guards).toContain(PermissionsGuard);
    });

    it('POST requires (create, PaymentDetail)', () => {
      const perms = reflector.getAllAndOverride<Array<[string, string]>>(
        PERMISSIONS_KEY,
        [
          AdminPaymentDetailController.prototype.create,
          AdminPaymentDetailController,
        ],
      );
      expect(perms).toEqual([['create', 'PaymentDetail']]);
    });

    it('GET (list) requires (read, PaymentDetail)', () => {
      const perms = reflector.getAllAndOverride<Array<[string, string]>>(
        PERMISSIONS_KEY,
        [
          AdminPaymentDetailController.prototype.findAll,
          AdminPaymentDetailController,
        ],
      );
      expect(perms).toEqual([['read', 'PaymentDetail']]);
    });

    it('GET (by id) requires (read, PaymentDetail)', () => {
      const perms = reflector.getAllAndOverride<Array<[string, string]>>(
        PERMISSIONS_KEY,
        [
          AdminPaymentDetailController.prototype.findOne,
          AdminPaymentDetailController,
        ],
      );
      expect(perms).toEqual([['read', 'PaymentDetail']]);
    });

    it('PATCH requires (update, PaymentDetail)', () => {
      const perms = reflector.getAllAndOverride<Array<[string, string]>>(
        PERMISSIONS_KEY,
        [
          AdminPaymentDetailController.prototype.update,
          AdminPaymentDetailController,
        ],
      );
      expect(perms).toEqual([['update', 'PaymentDetail']]);
    });

    it('DELETE requires (delete, PaymentDetail)', () => {
      const perms = reflector.getAllAndOverride<Array<[string, string]>>(
        PERMISSIONS_KEY,
        [
          AdminPaymentDetailController.prototype.remove,
          AdminPaymentDetailController,
        ],
      );
      expect(perms).toEqual([['delete', 'PaymentDetail']]);
    });
  });

  describe('POST /admin/payment-details', () => {
    it('returns 201 with the created entity', async () => {
      await request(httpServer())
        .post('/admin/payment-details')
        .send({
          bankName: 'BBVA',
          beneficiary: 'Tienda XYZ',
          clabe: '012345678901234567',
          accountNumber: '1234567890',
        })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            id: '11111111-1111-4111-8111-111111111111',
            tenantId: 'tenant-1',
            bankName: 'BBVA',
            clabe: '012345678901234567',
            isActive: true,
          });
        });
      expect(service.create).toHaveBeenCalledWith({
        bankName: 'BBVA',
        beneficiary: 'Tienda XYZ',
        clabe: '012345678901234567',
        accountNumber: '1234567890',
      });
    });

    it('returns 400 on invalid CLABE (17 digits)', async () => {
      await request(httpServer())
        .post('/admin/payment-details')
        .send({
          bankName: 'BBVA',
          beneficiary: 'Tienda XYZ',
          clabe: '01234567890123456', // 17 digits
          accountNumber: '1234567890',
        })
        .expect(400);
    });

    it('returns 400 on short accountNumber', async () => {
      await request(httpServer())
        .post('/admin/payment-details')
        .send({
          bankName: 'BBVA',
          beneficiary: 'Tienda XYZ',
          clabe: '012345678901234567',
          accountNumber: '123456789', // 9 digits
        })
        .expect(400);
    });

    it('returns 400 on empty bankName', async () => {
      await request(httpServer())
        .post('/admin/payment-details')
        .send({
          bankName: '   ',
          beneficiary: 'Tienda XYZ',
          clabe: '012345678901234567',
          accountNumber: '1234567890',
        })
        .expect(400);
    });

    it('returns 409 on DUPLICATE_CLABE', async () => {
      service.create.mockRejectedValueOnce(
        new BusinessRuleViolationError(
          'A PaymentDetail with this CLABE already exists for the tenant',
          'DUPLICATE_CLABE',
        ),
      );
      await request(httpServer())
        .post('/admin/payment-details')
        .send({
          bankName: 'BBVA',
          beneficiary: 'Tienda XYZ',
          clabe: '012345678901234567',
          accountNumber: '1234567890',
        })
        .expect(409);
    });
  });

  describe('GET /admin/payment-details', () => {
    it('returns 200 with the array', async () => {
      service.findAll.mockResolvedValueOnce([
        {
          id: '11111111-1111-4111-8111-111111111111',
          tenantId: 'tenant-1',
          bankName: 'BBVA',
          beneficiary: 'Tienda XYZ',
          clabe: '012345678901234567',
          accountNumber: '1234567890',
          isActive: true,
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-24T00:00:00.000Z',
        },
      ]);
      await request(httpServer())
        .get('/admin/payment-details')
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toHaveLength(1);
        });
    });
  });

  describe('GET /admin/payment-details/:id', () => {
    it('returns 200 with the entity', async () => {
      await request(httpServer())
        .get('/admin/payment-details/11111111-1111-4111-8111-111111111111')
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            id: '11111111-1111-4111-8111-111111111111',
          });
        });
    });

    it('returns 404 on miss', async () => {
      service.findOne.mockRejectedValueOnce(
        new EntityNotFoundError(
          'PaymentDetail',
          '22222222-2222-4222-8222-222222222222',
        ),
      );
      await request(httpServer())
        .get('/admin/payment-details/22222222-2222-4222-8222-222222222222')
        .expect(404);
    });
  });

  describe('PATCH /admin/payment-details/:id', () => {
    it('returns 200 with the updated entity', async () => {
      await request(httpServer())
        .patch('/admin/payment-details/11111111-1111-4111-8111-111111111111')
        .send({ beneficiary: 'Nuevo Beneficiario' })
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ beneficiary: 'Nuevo Beneficiario' });
        });
    });
  });

  describe('DELETE /admin/payment-details/:id', () => {
    it('returns 204 on success', async () => {
      await request(httpServer())
        .delete('/admin/payment-details/11111111-1111-4111-8111-111111111111')
        .expect(204);
    });

    it('returns 404 on miss', async () => {
      service.delete.mockRejectedValueOnce(
        new EntityNotFoundError(
          'PaymentDetail',
          '22222222-2222-4222-8222-222222222222',
        ),
      );
      await request(httpServer())
        .delete('/admin/payment-details/22222222-2222-4222-8222-222222222222')
        .expect(404);
    });
  });
});
