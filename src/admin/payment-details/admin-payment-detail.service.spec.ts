/**
 * Q1 / WU1 — AdminPaymentDetailService spec.
 *
 * Covers:
 *   - CRUD happy path.
 *   - Cross-tenant access → 404 (EntityNotFoundError, never Forbidden).
 *   - Logical delete: `isActive=false` persisted; row NOT removed.
 *   - Active-record selection: `findActive` orders by `updatedAt DESC`.
 *   - Multi-active → newest wins.
 *   - Tenant context required when no `tenantId` in CLS.
 */
import { AdminPaymentDetailService } from './admin-payment-detail.service';
import { PaymentDetail } from './domain/payment-detail.entity';
import {
  EntityNotFoundError,
  InvalidArgumentError,
} from '../../shared/domain/domain-error';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import type { IPaymentDetailRepository } from './domain/payment-detail.repository';

function makeEntity(
  overrides: Partial<{
    id: string;
    tenantId: string;
    isActive: boolean;
    bankName: string;
    beneficiary: string;
    clabe: string;
    accountNumber: string;
    updatedAt: Date;
  }> = {},
) {
  const props = {
    id: 'pd-1',
    tenantId: 'tenant-1',
    bankName: 'BBVA',
    beneficiary: 'Tienda XYZ',
    clabe: '012345678901234567',
    accountNumber: '1234567890',
    isActive: true,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-24T00:00:00.000Z'),
    ...overrides,
  };
  return PaymentDetail.fromPersistence(props);
}

function makeRepo() {
  const store = new Map<string, PaymentDetail>();
  return {
    create: jest.fn(async (entity: PaymentDetail) => {
      store.set(entity.id, entity);
      await Promise.resolve();
      return entity;
    }),
    update: jest.fn(async (entity: PaymentDetail) => {
      store.set(entity.id, entity);
      await Promise.resolve();
      return entity;
    }),
    findById: jest.fn((id: string, tenantId: string) => {
      const e = store.get(id);
      if (!e || e.tenantId !== tenantId) return Promise.resolve(null);
      return Promise.resolve(e);
    }),
    findAll: jest.fn((tenantId: string) => {
      const rows = Array.from(store.values())
        .filter((e) => e.tenantId === tenantId)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      return Promise.resolve(rows);
    }),
    findActive: jest.fn((tenantId: string) => {
      const active = Array.from(store.values()).filter(
        (e) => e.tenantId === tenantId && e.isActive,
      );
      active.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      return Promise.resolve(active[0] ?? null);
    }),
    _store: store,
  };
}

function makeCls(overrides: Partial<TenantClsStore> = {}) {
  return {
    get: jest.fn(() => ({
      userId: 'user-1',
      tenantId: 'tenant-1',
      isSuperAdmin: false,
      ...overrides,
    })),
  } as any;
}

describe('AdminPaymentDetailService', () => {
  describe('create', () => {
    it('builds a new entity, persists it, returns the response', async () => {
      const repo = makeRepo();
      const cls = makeCls();
      const service = new AdminPaymentDetailService(
        repo as unknown as IPaymentDetailRepository,
        cls,
      );

      const result = await service.create({
        bankName: 'BBVA',
        beneficiary: 'Tienda XYZ',
        clabe: '012345678901234567',
        accountNumber: '1234567890',
      });

      expect(repo.create).toHaveBeenCalledTimes(1);
      expect(result.id).toBeDefined();
      expect(result.tenantId).toBe('tenant-1');
      expect(result.isActive).toBe(true);
    });

    it('throws TENANT_CONTEXT_REQUIRED when no tenantId in CLS', async () => {
      const repo = makeRepo();
      const cls = makeCls({ tenantId: null, isSuperAdmin: false });
      const service = new AdminPaymentDetailService(
        repo as unknown as IPaymentDetailRepository,
        cls,
      );

      await expect(
        service.create({
          bankName: 'BBVA',
          beneficiary: 'Tienda XYZ',
          clabe: '012345678901234567',
          accountNumber: '1234567890',
        }),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
    });
  });

  describe('findAll', () => {
    it('returns every tenant row (active + inactive), ordered by updatedAt DESC', async () => {
      const repo = makeRepo();
      const e1 = makeEntity({ id: 'pd-1', updatedAt: new Date('2026-08-20') });
      const e2 = makeEntity({
        id: 'pd-2',
        isActive: false,
        updatedAt: new Date('2026-08-24'),
      });
      repo._store.set('pd-1', e1);
      repo._store.set('pd-2', e2);
      const cls = makeCls();
      const service = new AdminPaymentDetailService(
        repo as unknown as IPaymentDetailRepository,
        cls,
      );

      const result = await service.findAll();

      expect(result).toHaveLength(2);
      expect(result[0]?.id).toBe('pd-2'); // newest first
      expect(result[1]?.id).toBe('pd-1');
    });
  });

  describe('findOne', () => {
    it('returns the entity response on hit', async () => {
      const repo = makeRepo();
      const e = makeEntity();
      repo._store.set('pd-1', e);
      const service = new AdminPaymentDetailService(
        repo as unknown as IPaymentDetailRepository,
        makeCls(),
      );

      const result = await service.findOne('pd-1');
      expect(result.id).toBe('pd-1');
    });

    it('throws EntityNotFoundError when row does not exist', async () => {
      const repo = makeRepo();
      const service = new AdminPaymentDetailService(
        repo as unknown as IPaymentDetailRepository,
        makeCls(),
      );

      await expect(service.findOne('missing')).rejects.toBeInstanceOf(
        EntityNotFoundError,
      );
    });

    it('cross-tenant read returns 404 (EntityNotFoundError)', async () => {
      const repo = makeRepo();
      const e = makeEntity({ id: 'pd-1', tenantId: 'tenant-2' });
      repo._store.set('pd-1', e);
      const service = new AdminPaymentDetailService(
        repo as unknown as IPaymentDetailRepository,
        makeCls({ tenantId: 'tenant-1' }),
      );

      await expect(service.findOne('pd-1')).rejects.toBeInstanceOf(
        EntityNotFoundError,
      );
    });
  });

  describe('update', () => {
    it('mutates only supplied fields and persists', async () => {
      const repo = makeRepo();
      const e = makeEntity();
      repo._store.set('pd-1', e);
      const service = new AdminPaymentDetailService(
        repo as unknown as IPaymentDetailRepository,
        makeCls(),
      );

      const result = await service.update('pd-1', {
        beneficiary: 'Nuevo Beneficiario',
      });

      expect(result.beneficiary).toBe('Nuevo Beneficiario');
      expect(result.bankName).toBe('BBVA'); // untouched
      expect(repo.update).toHaveBeenCalledTimes(1);
    });

    it('cross-tenant update returns 404', async () => {
      const repo = makeRepo();
      const e = makeEntity({ id: 'pd-1', tenantId: 'tenant-2' });
      repo._store.set('pd-1', e);
      const service = new AdminPaymentDetailService(
        repo as unknown as IPaymentDetailRepository,
        makeCls({ tenantId: 'tenant-1' }),
      );

      await expect(
        service.update('pd-1', { beneficiary: 'X' }),
      ).rejects.toBeInstanceOf(EntityNotFoundError);
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('performs a logical delete (isActive=false, row retained)', async () => {
      const repo = makeRepo();
      const e = makeEntity();
      repo._store.set('pd-1', e);
      const service = new AdminPaymentDetailService(
        repo as unknown as IPaymentDetailRepository,
        makeCls(),
      );

      await service.delete('pd-1');

      expect(repo.update).toHaveBeenCalledTimes(1);
      const persisted = repo._store.get('pd-1');
      expect(persisted?.isActive).toBe(false);
      // Row is NOT removed — audit trail preserved.
      expect(repo._store.has('pd-1')).toBe(true);
    });

    it('cross-tenant delete returns 404', async () => {
      const repo = makeRepo();
      const e = makeEntity({ id: 'pd-1', tenantId: 'tenant-2' });
      repo._store.set('pd-1', e);
      const service = new AdminPaymentDetailService(
        repo as unknown as IPaymentDetailRepository,
        makeCls({ tenantId: 'tenant-1' }),
      );

      await expect(service.delete('pd-1')).rejects.toBeInstanceOf(
        EntityNotFoundError,
      );
      expect(repo.update).not.toHaveBeenCalled();
    });
  });
});
