/**
 * WU1 — AdminPaymentMethodService spec.
 *
 * Covers:
 *   - CRUD happy path.
 *   - Cross-tenant access → 404 (EntityNotFoundError, never Forbidden).
 *   - Logical delete: `isActive=false` persisted; row NOT removed.
 *   - Reactivation via PATCH `{ isActive: true }`.
 *   - Multi-row listing ordered by `updatedAt DESC`.
 *   - Tenant context required when no `tenantId` in CLS.
 */
import { AdminPaymentMethodService } from './admin-payment-method.service';
import { PaymentMethod } from './domain/payment-method.entity';
import {
  EntityNotFoundError,
  InvalidArgumentError,
} from '../../shared/domain/domain-error';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import type { IPaymentMethodRepository } from './domain/payment-method.repository';

function makeEntity(
  overrides: Partial<{
    id: string;
    tenantId: string;
    isActive: boolean;
    name: string;
    category: 'cash' | 'card_credit' | 'card_debit' | 'transfer';
    subtitle: string | null;
    updatedAt: Date;
  }> = {},
) {
  const props = {
    id: 'pm-1',
    tenantId: 'tenant-1',
    name: 'Mercado Pago',
    category: 'transfer' as const,
    subtitle: null,
    isActive: true,
    metadataJson: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-24T00:00:00.000Z'),
    ...overrides,
  };
  return PaymentMethod.fromPersistence(props);
}

function makeRepo() {
  const store = new Map<string, PaymentMethod>();
  return {
    create: jest.fn(async (entity: PaymentMethod) => {
      store.set(entity.id, entity);
      await Promise.resolve();
      return entity;
    }),
    update: jest.fn(async (entity: PaymentMethod) => {
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
    findAllActive: jest.fn(),
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

describe('AdminPaymentMethodService', () => {
  describe('create', () => {
    it('builds a new entity, persists it, returns the response', async () => {
      const repo = makeRepo();
      const cls = makeCls();
      const service = new AdminPaymentMethodService(
        repo as unknown as IPaymentMethodRepository,
        cls,
      );

      const result = await service.create({
        name: 'Mercado Pago',
        category: 'transfer',
      });

      expect(repo.create).toHaveBeenCalledTimes(1);
      expect(result.id).toBeDefined();
      expect(result.tenantId).toBe('tenant-1');
      expect(result.name).toBe('Mercado Pago');
      expect(result.category).toBe('transfer');
      expect(result.isActive).toBe(true);
    });

    it('throws TENANT_CONTEXT_REQUIRED when no tenantId in CLS', async () => {
      const repo = makeRepo();
      const cls = makeCls({ tenantId: null, isSuperAdmin: false });
      const service = new AdminPaymentMethodService(
        repo as unknown as IPaymentMethodRepository,
        cls,
      );

      await expect(
        service.create({
          name: 'Mercado Pago',
          category: 'transfer',
        }),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
    });
  });

  describe('findAll', () => {
    it('returns every tenant row (active + inactive), ordered by updatedAt DESC', async () => {
      const repo = makeRepo();
      const e1 = makeEntity({ id: 'pm-1', updatedAt: new Date('2026-08-20') });
      const e2 = makeEntity({
        id: 'pm-2',
        isActive: false,
        updatedAt: new Date('2026-08-24'),
      });
      repo._store.set('pm-1', e1);
      repo._store.set('pm-2', e2);
      const cls = makeCls();
      const service = new AdminPaymentMethodService(
        repo as unknown as IPaymentMethodRepository,
        cls,
      );

      const result = await service.findAll();

      expect(result).toHaveLength(2);
      expect(result[0]?.id).toBe('pm-2'); // newest first
      expect(result[1]?.id).toBe('pm-1');
    });
  });

  describe('findOne', () => {
    it('returns the entity response on hit', async () => {
      const repo = makeRepo();
      const e = makeEntity();
      repo._store.set('pm-1', e);
      const service = new AdminPaymentMethodService(
        repo as unknown as IPaymentMethodRepository,
        makeCls(),
      );

      const result = await service.findOne('pm-1');
      expect(result.id).toBe('pm-1');
    });

    it('throws EntityNotFoundError when row does not exist', async () => {
      const repo = makeRepo();
      const service = new AdminPaymentMethodService(
        repo as unknown as IPaymentMethodRepository,
        makeCls(),
      );

      await expect(service.findOne('missing')).rejects.toBeInstanceOf(
        EntityNotFoundError,
      );
    });

    it('cross-tenant read returns 404 (EntityNotFoundError)', async () => {
      const repo = makeRepo();
      const e = makeEntity({ id: 'pm-1', tenantId: 'tenant-2' });
      repo._store.set('pm-1', e);
      const service = new AdminPaymentMethodService(
        repo as unknown as IPaymentMethodRepository,
        makeCls({ tenantId: 'tenant-1' }),
      );

      await expect(service.findOne('pm-1')).rejects.toBeInstanceOf(
        EntityNotFoundError,
      );
    });
  });

  describe('update', () => {
    it('mutates only supplied fields and persists', async () => {
      const repo = makeRepo();
      const e = makeEntity();
      repo._store.set('pm-1', e);
      const service = new AdminPaymentMethodService(
        repo as unknown as IPaymentMethodRepository,
        makeCls(),
      );

      const result = await service.update('pm-1', {
        subtitle: 'Link de pago',
      });

      expect(result.subtitle).toBe('Link de pago');
      expect(result.name).toBe('Mercado Pago'); // untouched
      expect(repo.update).toHaveBeenCalledTimes(1);
    });

    it('reactivates via PATCH { isActive: true } (D2)', async () => {
      const repo = makeRepo();
      const e = makeEntity({ isActive: false });
      repo._store.set('pm-1', e);
      const service = new AdminPaymentMethodService(
        repo as unknown as IPaymentMethodRepository,
        makeCls(),
      );

      const result = await service.update('pm-1', { isActive: true });
      expect(result.isActive).toBe(true);
    });

    it('cross-tenant update returns 404', async () => {
      const repo = makeRepo();
      const e = makeEntity({ id: 'pm-1', tenantId: 'tenant-2' });
      repo._store.set('pm-1', e);
      const service = new AdminPaymentMethodService(
        repo as unknown as IPaymentMethodRepository,
        makeCls({ tenantId: 'tenant-1' }),
      );

      await expect(
        service.update('pm-1', { subtitle: 'X' }),
      ).rejects.toBeInstanceOf(EntityNotFoundError);
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('performs a logical delete (isActive=false, row retained)', async () => {
      const repo = makeRepo();
      const e = makeEntity();
      repo._store.set('pm-1', e);
      const service = new AdminPaymentMethodService(
        repo as unknown as IPaymentMethodRepository,
        makeCls(),
      );

      await service.delete('pm-1');

      expect(repo.update).toHaveBeenCalledTimes(1);
      const persisted = repo._store.get('pm-1');
      expect(persisted?.isActive).toBe(false);
      // Row is NOT removed — audit trail preserved.
      expect(repo._store.has('pm-1')).toBe(true);
    });

    it('cross-tenant delete returns 404', async () => {
      const repo = makeRepo();
      const e = makeEntity({ id: 'pm-1', tenantId: 'tenant-2' });
      repo._store.set('pm-1', e);
      const service = new AdminPaymentMethodService(
        repo as unknown as IPaymentMethodRepository,
        makeCls({ tenantId: 'tenant-1' }),
      );

      await expect(service.delete('pm-1')).rejects.toBeInstanceOf(
        EntityNotFoundError,
      );
      expect(repo.update).not.toHaveBeenCalled();
    });
  });
});