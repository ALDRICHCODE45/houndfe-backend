/**
 * WU2 — PaymentMethodCatalogResolver spec.
 *
 * Covers:
 *   - `resolveActive` happy path (active row + matching category).
 *   - `resolveActive` not-found (null or cross-tenant) → PAYMENT_METHOD_NOT_FOUND.
 *   - `resolveActive` inactive → INACTIVE_PAYMENT_METHOD.
 *   - `resolveActive` category mismatch → PAYMENT_METHOD_CATEGORY_MISMATCH.
 *   - `listActive` projects active rows to the narrow DTO shape.
 */
import { PaymentMethodCatalogResolver } from './payment-method-catalog.resolver';
import { PaymentMethod } from './domain/payment-method.entity';
import type { IPaymentMethodRepository } from './domain/payment-method.repository';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';

function makeRepo() {
  const store = new Map<string, PaymentMethod>();
  return {
    create: jest.fn(async (e: PaymentMethod) => {
      store.set(e.id, e);
      return e;
    }),
    update: jest.fn(async (e: PaymentMethod) => {
      store.set(e.id, e);
      return e;
    }),
    findById: jest.fn((id: string, tenantId: string) => {
      const e = store.get(id);
      if (!e || e.tenantId !== tenantId) return Promise.resolve(null);
      return Promise.resolve(e);
    }),
    findAll: jest.fn((tenantId: string) => {
      const rows = Array.from(store.values()).filter(
        (e) => e.tenantId === tenantId,
      );
      return Promise.resolve(rows);
    }),
    findAllActive: jest.fn((tenantId: string) => {
      const rows = Array.from(store.values()).filter(
        (e) => e.tenantId === tenantId && e.isActive,
      );
      return Promise.resolve(rows);
    }),
    _store: store,
  } as unknown as IPaymentMethodRepository & {
    _store: Map<string, PaymentMethod>;
  };
}

describe('PaymentMethodCatalogResolver', () => {
  describe('resolveActive', () => {
    it('returns the resolved row when active + category matches', async () => {
      const repo = makeRepo();
      const entity = PaymentMethod.fromPersistence({
        id: 'pm-1',
        tenantId: 'tenant-1',
        name: 'Mercado Pago',
        category: 'transfer',
        subtitle: 'Link',
        isActive: true,
        metadataJson: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      repo._store.set('pm-1', entity);
      const resolver = new PaymentMethodCatalogResolver(repo);

      const result = await resolver.resolveActive({
        paymentMethodId: 'pm-1',
        tenantId: 'tenant-1',
        expectedCategory: 'transfer',
      });

      expect(result).toEqual({
        category: 'transfer',
        name: 'Mercado Pago',
        subtitle: 'Link',
      });
    });

    it('throws PAYMENT_METHOD_NOT_FOUND on cross-tenant miss', async () => {
      const repo = makeRepo();
      const resolver = new PaymentMethodCatalogResolver(repo);

      await expect(
        resolver.resolveActive({
          paymentMethodId: 'pm-foreign',
          tenantId: 'tenant-1',
          expectedCategory: 'transfer',
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_METHOD_NOT_FOUND' });
      await expect(
        resolver.resolveActive({
          paymentMethodId: 'pm-foreign',
          tenantId: 'tenant-1',
          expectedCategory: 'transfer',
        }),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
    });

    it('throws INACTIVE_PAYMENT_METHOD when isActive=false', async () => {
      const repo = makeRepo();
      const entity = PaymentMethod.fromPersistence({
        id: 'pm-1',
        tenantId: 'tenant-1',
        name: 'Mercado Pago',
        category: 'transfer',
        subtitle: null,
        isActive: false,
        metadataJson: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      repo._store.set('pm-1', entity);
      const resolver = new PaymentMethodCatalogResolver(repo);

      await expect(
        resolver.resolveActive({
          paymentMethodId: 'pm-1',
          tenantId: 'tenant-1',
          expectedCategory: 'transfer',
        }),
      ).rejects.toMatchObject({ code: 'INACTIVE_PAYMENT_METHOD' });
    });

    it('throws PAYMENT_METHOD_CATEGORY_MISMATCH on case-insensitive category mismatch', async () => {
      const repo = makeRepo();
      const entity = PaymentMethod.fromPersistence({
        id: 'pm-1',
        tenantId: 'tenant-1',
        name: 'Mercado Pago',
        category: 'transfer',
        subtitle: null,
        isActive: true,
        metadataJson: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      repo._store.set('pm-1', entity);
      const resolver = new PaymentMethodCatalogResolver(repo);

      await expect(
        resolver.resolveActive({
          paymentMethodId: 'pm-1',
          tenantId: 'tenant-1',
          expectedCategory: 'cash',
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_METHOD_CATEGORY_MISMATCH' });
    });
  });

  describe('listActive', () => {
    it('returns only active rows projected to the narrow DTO shape', async () => {
      const repo = makeRepo();
      const active = PaymentMethod.fromPersistence({
        id: 'pm-1',
        tenantId: 'tenant-1',
        name: 'Mercado Pago',
        category: 'transfer',
        subtitle: 'Link',
        isActive: true,
        metadataJson: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const inactive = PaymentMethod.fromPersistence({
        id: 'pm-2',
        tenantId: 'tenant-1',
        name: 'OXXO Pay',
        category: 'transfer',
        subtitle: null,
        isActive: false,
        metadataJson: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      repo._store.set('pm-1', active);
      repo._store.set('pm-2', inactive);
      const resolver = new PaymentMethodCatalogResolver(repo);

      const result = await resolver.listActive('tenant-1');

      expect(result).toEqual([
        {
          id: 'pm-1',
          name: 'Mercado Pago',
          category: 'transfer',
          subtitle: 'Link',
        },
      ]);
    });

    it('returns empty array when no active rows', async () => {
      const repo = makeRepo();
      const resolver = new PaymentMethodCatalogResolver(repo);
      const result = await resolver.listActive('tenant-1');
      expect(result).toEqual([]);
    });
  });
});