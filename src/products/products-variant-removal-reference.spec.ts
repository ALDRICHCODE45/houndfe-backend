import { ProductsService } from './products.service';
import { EntityNotFoundError } from '../shared/domain/domain-error';
import type { IProductRepository } from './domain/product.repository';
import type { PrismaService } from '../shared/prisma/prisma.service';
import type { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import type { FilesService } from '../files/files.service';
import type { SatCatalogService } from '../sat-catalog/sat-catalog.service';

const tenantId = 'tenant-1';
const productId = 'product-1';
const variantId = 'variant-1';

function fixture(sibling = false) {
  const events: string[] = [];
  const initial = {
    variants: sibling ? [variantId, 'sibling'] : [variantId],
    hasVariants: true,
  };
  let persisted = structuredClone(initial);
  let pending = structuredClone(initial);
  let active = false;
  const root = {
    product: {
      update: jest.fn(() => {
        throw new Error('root Product write forbidden');
      }),
    },
  };
  const tx = {
    $queryRaw: jest.fn(() => {
      events.push('gate');
      expect(active).toBe(true);
      return Promise.resolve([{ id: productId }]);
    }),
    variant: {
      findFirst: jest.fn(() => {
        events.push('read');
        expect(active).toBe(true);
        return Promise.resolve({ id: variantId } as { id: string } | null);
      }),
      delete: jest.fn(() => {
        events.push('delete');
        pending.variants = pending.variants.filter((id) => id !== variantId);
        return Promise.resolve({ id: variantId });
      }),
      count: jest.fn(() => {
        events.push('count');
        return Promise.resolve(pending.variants.length);
      }),
    },
    product: {
      update: jest.fn(({ data }: { data: { hasVariants: boolean } }) => {
        events.push('flag');
        pending.hasVariants = data.hasVariants;
        return Promise.resolve(data);
      }),
    },
  };
  const tenant = {
    getTenantId: jest.fn(() => tenantId),
    getClient: jest.fn(() => (active ? tx : root)),
    runInTransaction: jest.fn(async (work: () => Promise<unknown>) => {
      active = true;
      pending = structuredClone(persisted);
      try {
        const result = await work();
        persisted = structuredClone(pending);
        return result;
      } finally {
        active = false;
      }
    }),
  };
  const service = new ProductsService(
    {} as IProductRepository,
    root as unknown as PrismaService,
    {} as FilesService,
    tenant as unknown as TenantPrismaService,
    {} as SatCatalogService,
  );
  return {
    service,
    tenant,
    tx,
    root,
    events,
    initial,
    effects: () => persisted,
  };
}

describe('removeVariant Product-first atomic membership (S3/S5)', () => {
  it.each([false, true])(
    'commits qualified deletion with void success; sibling=%s',
    async (sibling) => {
      const f = fixture(sibling);
      await expect(
        f.service.removeVariant(productId, variantId),
      ).resolves.toBeUndefined();
      expect(f.events).toEqual(
        sibling
          ? ['gate', 'read', 'delete', 'count']
          : ['gate', 'read', 'delete', 'count', 'flag'],
      );
      const [query] = f.tx.$queryRaw.mock.calls[0] as unknown as [
        { strings: string[]; values: unknown[] },
      ];
      expect(query.strings.join('?')).toMatch(
        /SELECT "id" FROM "products" WHERE "tenantId" = \?\s+AND "id" = \? FOR UPDATE/,
      );
      expect(query.values).toEqual([tenantId, productId]);
      expect(f.tenant.getTenantId).toHaveBeenCalledTimes(1);
      expect(f.tenant.runInTransaction).toHaveBeenCalledTimes(1);
      expect(f.tx.variant.findFirst).toHaveBeenCalledWith({
        where: { id: variantId, productId, tenantId },
      });
      expect(f.tx.variant.delete).toHaveBeenCalledWith({
        where: { id: variantId, productId, tenantId },
      });
      expect(f.tx.variant.count).toHaveBeenCalledWith({
        where: { productId, tenantId },
      });
      if (sibling) {
        expect(f.tx.product.update).not.toHaveBeenCalled();
      } else {
        expect(f.tx.product.update).toHaveBeenCalledWith({
          where: { id: productId, tenantId },
          data: { hasVariants: false },
        });
      }
      expect(f.root.product.update).not.toHaveBeenCalled();
      expect(f.effects()).toEqual({
        variants: sibling ? ['sibling'] : [],
        hasVariants: sibling,
      });
    },
  );

  it.each(['gate error', 'empty gate', 'missing variant'])(
    'rejects %s before mutations without disclosing a Product error',
    async (failure) => {
      const f = fixture();
      const error = new Error('gate SQL failed');
      if (failure === 'gate error') f.tx.$queryRaw.mockRejectedValueOnce(error);
      if (failure === 'empty gate') f.tx.$queryRaw.mockResolvedValueOnce([]);
      if (failure === 'missing variant')
        f.tx.variant.findFirst.mockResolvedValueOnce(null);
      const result = f.service.removeVariant(productId, variantId);
      if (failure === 'gate error') {
        await expect(result).rejects.toBe(error);
      } else {
        await expect(result).rejects.toBeInstanceOf(EntityNotFoundError);
        await expect(result).rejects.toMatchObject({
          message: `Variant with id "${variantId}" not found`,
          code: 'ENTITY_NOT_FOUND',
        });
      }
      expect(f.tx.$queryRaw).toHaveBeenCalledTimes(1);
      expect(f.tx.variant.findFirst).toHaveBeenCalledTimes(
        failure === 'missing variant' ? 1 : 0,
      );
      expect(f.tx.variant.delete).not.toHaveBeenCalled();
      expect(f.tx.variant.count).not.toHaveBeenCalled();
      expect(f.tx.product.update).not.toHaveBeenCalled();
      expect(f.root.product.update).not.toHaveBeenCalled();
      expect(f.effects()).toEqual(f.initial);
    },
  );

  it.each(['count', 'flag'])(
    'propagates late %s failure and discards staged effects without retry',
    async (failure) => {
      const f = fixture();
      const error = new Error(`${failure} failed`);
      if (failure === 'count') {
        f.tx.variant.count.mockRejectedValueOnce(error);
      } else {
        const update = f.tx.product.update.getMockImplementation()!;
        f.tx.product.update.mockImplementationOnce(async (args) => {
          // Model a staged flag write followed by failure.
          await update(args);
          throw error;
        });
      }
      await expect(f.service.removeVariant(productId, variantId)).rejects.toBe(
        error,
      );
      expect(f.tx.variant.delete).toHaveBeenCalledTimes(1);
      expect(f.tx.variant.count).toHaveBeenCalledTimes(1);
      expect(f.tx.product.update).toHaveBeenCalledTimes(
        failure === 'flag' ? 1 : 0,
      );
      expect(f.tenant.runInTransaction).toHaveBeenCalledTimes(1);
      expect(f.root.product.update).not.toHaveBeenCalled();
      expect(f.effects()).toEqual(f.initial);
    },
  );
});
