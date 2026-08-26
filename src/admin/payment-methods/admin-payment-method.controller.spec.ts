/**
 * WU1 — AdminPaymentMethodController spec.
 *
 * Covers:
 *   - `@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)` is
 *     applied at the class level.
 *   - `@RequirePermissions(['<action>', 'PaymentMethod'])` is set per route
 *     (verified via the metadata reflection helper `getAllAndOverride`).
 *   - 201 on POST, 204 on DELETE.
 *   - 400 on invalid DTO (category not in the 4-value enum).
 *   - 409 on DUPLICATE_NAME.
 *   - 404 on cross-tenant / miss.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import request from 'supertest';
import { AdminPaymentMethodController } from './admin-payment-method.controller';
import { AdminPaymentMethodService } from './admin-payment-method.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { PERMISSIONS_KEY } from '../../auth/authorization/decorators/require-permissions.decorator';
import { DomainExceptionFilter } from '../../shared/filters/domain-exception.filter';
import {
  BusinessRuleViolationError,
  EntityNotFoundError,
} from '../../shared/domain/domain-error';

describe('AdminPaymentMethodController', () => {
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
        name: 'Mercado Pago',
        category: 'transfer',
        subtitle: null,
        isActive: true,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z',
      }),
      create: jest.fn().mockResolvedValue({
        id: '11111111-1111-4111-8111-111111111111',
        tenantId: 'tenant-1',
        name: 'Mercado Pago',
        category: 'transfer',
        subtitle: null,
        isActive: true,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z',
      }),
      update: jest.fn().mockResolvedValue({
        id: '11111111-1111-4111-8111-111111111111',
        tenantId: 'tenant-1',
        name: 'Mercado Pago',
        category: 'transfer',
        subtitle: 'Link',
        isActive: true,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      }),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [AdminPaymentMethodController],
      providers: [{ provide: AdminPaymentMethodService, useValue: service }],
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
        AdminPaymentMethodController,
        undefined,
      ]);
      expect(guards).toBeDefined();
      // The metadata is the constructor function for each guard.
      expect(guards).toHaveLength(3);
      expect(guards).toContain(JwtAuthGuard);
      expect(guards).toContain(TenantContextGuard);
      expect(guards).toContain(PermissionsGuard);
    });

    it('POST requires (create, PaymentMethod)', () => {
      const perms = reflector.getAllAndOverride<Array<[string, string]>>(
        PERMISSIONS_KEY,
        [
          AdminPaymentMethodController.prototype.create,
          AdminPaymentMethodController,
        ],
      );
      expect(perms).toEqual([['create', 'PaymentMethod']]);
    });

    it('GET (list) requires (read, PaymentMethod)', () => {
      const perms = reflector.getAllAndOverride<Array<[string, string]>>(
        PERMISSIONS_KEY,
        [
          AdminPaymentMethodController.prototype.findAll,
          AdminPaymentMethodController,
        ],
      );
      expect(perms).toEqual([['read', 'PaymentMethod']]);
    });

    it('GET (by id) requires (read, PaymentMethod)', () => {
      const perms = reflector.getAllAndOverride<Array<[string, string]>>(
        PERMISSIONS_KEY,
        [
          AdminPaymentMethodController.prototype.findOne,
          AdminPaymentMethodController,
        ],
      );
      expect(perms).toEqual([['read', 'PaymentMethod']]);
    });

    it('PATCH requires (update, PaymentMethod)', () => {
      const perms = reflector.getAllAndOverride<Array<[string, string]>>(
        PERMISSIONS_KEY,
        [
          AdminPaymentMethodController.prototype.update,
          AdminPaymentMethodController,
        ],
      );
      expect(perms).toEqual([['update', 'PaymentMethod']]);
    });

    it('DELETE requires (delete, PaymentMethod)', () => {
      const perms = reflector.getAllAndOverride<Array<[string, string]>>(
        PERMISSIONS_KEY,
        [
          AdminPaymentMethodController.prototype.remove,
          AdminPaymentMethodController,
        ],
      );
      expect(perms).toEqual([['delete', 'PaymentMethod']]);
    });
  });

  describe('POST /admin/payment-methods', () => {
    it('returns 201 with the created entity', async () => {
      await request(httpServer())
        .post('/admin/payment-methods')
        .send({ name: 'Mercado Pago', category: 'transfer' })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            id: '11111111-1111-4111-8111-111111111111',
            tenantId: 'tenant-1',
            name: 'Mercado Pago',
            category: 'transfer',
            isActive: true,
          });
        });
      expect(service.create).toHaveBeenCalledWith({
        name: 'Mercado Pago',
        category: 'transfer',
      });
    });

    it('returns 400 on invalid category (credit)', async () => {
      await request(httpServer())
        .post('/admin/payment-methods')
        .send({ name: 'Credit Card', category: 'credit' })
        .expect(400);
    });

    it('returns 400 on empty name', async () => {
      await request(httpServer())
        .post('/admin/payment-methods')
        .send({ name: '   ', category: 'transfer' })
        .expect(400);
    });

    it('returns 400 on 61-char name', async () => {
      await request(httpServer())
        .post('/admin/payment-methods')
        .send({ name: 'x'.repeat(61), category: 'transfer' })
        .expect(400);
    });

    it('returns 400 on 121-char subtitle', async () => {
      await request(httpServer())
        .post('/admin/payment-methods')
        .send({
          name: 'Mercado Pago',
          category: 'transfer',
          subtitle: 'x'.repeat(121),
        })
        .expect(400);
    });

    it('returns 409 on DUPLICATE_NAME', async () => {
      service.create.mockRejectedValueOnce(
        new BusinessRuleViolationError(
          'A PaymentMethod with this name already exists for the tenant',
          'DUPLICATE_NAME',
        ),
      );
      await request(httpServer())
        .post('/admin/payment-methods')
        .send({ name: 'Mercado Pago', category: 'transfer' })
        .expect(409);
    });
  });

  describe('GET /admin/payment-methods', () => {
    it('returns 200 with the array', async () => {
      service.findAll.mockResolvedValueOnce([
        {
          id: '11111111-1111-4111-8111-111111111111',
          tenantId: 'tenant-1',
          name: 'Mercado Pago',
          category: 'transfer',
          subtitle: null,
          isActive: true,
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-24T00:00:00.000Z',
        },
      ]);
      await request(httpServer())
        .get('/admin/payment-methods')
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toHaveLength(1);
        });
    });
  });

  describe('GET /admin/payment-methods/:id', () => {
    it('returns 200 with the entity', async () => {
      await request(httpServer())
        .get('/admin/payment-methods/11111111-1111-4111-8111-111111111111')
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
          'PaymentMethod',
          '22222222-2222-4222-8222-222222222222',
        ),
      );
      await request(httpServer())
        .get('/admin/payment-methods/22222222-2222-4222-8222-222222222222')
        .expect(404);
    });
  });

  describe('PATCH /admin/payment-methods/:id', () => {
    it('returns 200 with the updated entity', async () => {
      await request(httpServer())
        .patch('/admin/payment-methods/11111111-1111-4111-8111-111111111111')
        .send({ subtitle: 'Link' })
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ subtitle: 'Link' });
        });
    });

    it('returns 200 when reactivating isActive=true', async () => {
      service.update.mockResolvedValueOnce({
        id: '11111111-1111-4111-8111-111111111111',
        tenantId: 'tenant-1',
        name: 'Mercado Pago',
        category: 'transfer',
        subtitle: null,
        isActive: true,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      });
      await request(httpServer())
        .patch('/admin/payment-methods/11111111-1111-4111-8111-111111111111')
        .send({ isActive: true })
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ isActive: true });
        });
    });
  });

  describe('DELETE /admin/payment-methods/:id', () => {
    it('returns 204 on success', async () => {
      await request(httpServer())
        .delete('/admin/payment-methods/11111111-1111-4111-8111-111111111111')
        .expect(204);
    });

    it('returns 404 on miss', async () => {
      service.delete.mockRejectedValueOnce(
        new EntityNotFoundError(
          'PaymentMethod',
          '22222222-2222-4222-8222-222222222222',
        ),
      );
      await request(httpServer())
        .delete('/admin/payment-methods/22222222-2222-4222-8222-222222222222')
        .expect(404);
    });
  });
});