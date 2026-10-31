import {
  CatalogPublishMode,
  CatalogStockPresentation,
  Prisma,
} from '@prisma/client';
import { ProductsService } from './products.service';
import type { UpdateVariantDto } from './dto/variant.dto';
import {
  EntityAlreadyExistsError,
  EntityNotFoundError,
  InvalidArgumentError,
} from '../shared/domain/domain-error';

const productId = 'product';
const variantId = 'variant';
const tenantId = 'tenant';
function setup() {
  const row = {
    id: variantId,
    productId,
    tenantId,
    name: 'Fresh',
    option: null,
    value: null,
    sku: 'SKU',
    barcode: 'BAR',
    quantity: 10,
    minQuantity: 2,
    purchaseNetCostCents: null as number | null,
    catalogPublishMode: CatalogPublishMode.INHERIT,
    onlineStockPresentation: null as CatalogStockPresentation | null,
    onlineStockPresentationCustomQty: null as number | null,
    product: { useStock: true },
  };
  let inside = false;
  const events: string[] = [];
  const record = (name: string) =>
    events.push(`${inside ? 'tx' : 'root'}:${name}`);
  const tx = {
    $queryRaw: jest.fn<Promise<{ id: string }[]>, [Prisma.Sql]>(() => {
      record('gate');
      return Promise.resolve([{ id: productId }]);
    }),
    variant: {
      findFirst: jest.fn<Promise<typeof row | null>, [unknown]>(() => {
        record('read');
        return Promise.resolve(row);
      }),
      update: jest.fn(({ data }: { data: object; where: object }) => {
        record('update');
        return Promise.resolve({ ...row, ...data });
      }),
    },
  };
  const root = {
    variant: {
      findFirst: jest.fn(() => {
        record('stale-read');
        return Promise.resolve({ ...row, name: 'Stale' });
      }),
    },
  };
  const repo = {
    isSkuTaken: jest.fn<Promise<boolean>, [string, object]>(() => {
      record('sku');
      return Promise.resolve(false);
    }),
    isBarcodeTaken: jest.fn<Promise<boolean>, [string, object]>(() => {
      record('barcode');
      return Promise.resolve(false);
    }),
    rearmAlertAfterEdit: jest.fn<Promise<void>, [object]>(() => {
      record('rearm');
      return Promise.resolve();
    }),
  };
  const tenant = {
    getTenantId: () => tenantId,
    getClient: () => (inside ? tx : root),
    runInTransaction: jest.fn(async (work: () => Promise<unknown>) => {
      events.push('begin');
      inside = true;
      try {
        const result = await work();
        events.push('commit');
        return result;
      } catch (error) {
        events.push('rollback');
        throw error;
      } finally {
        inside = false;
      }
    }),
  };
  type Args = ConstructorParameters<typeof ProductsService>;
  const service = new ProductsService(
    repo as unknown as Args[0],
    root as unknown as Args[1],
    {} as Args[2],
    tenant as unknown as Args[3],
    {} as Args[4],
  );
  return { service, row, tx, root, repo, tenant, events };
}

it('takes the qualified parent gate before any read, uniqueness check, update or rearm', async () => {
  const s = setup();
  const result = await s.service.updateVariant(productId, variantId, {
    sku: ' sku ',
    barcode: ' bar ',
    quantity: 9,
  });
  expect(s.events).toEqual([
    'begin',
    'tx:gate',
    'tx:read',
    'tx:sku',
    'tx:barcode',
    'tx:update',
    'tx:rearm',
    'commit',
  ]);
  const query = s.tx.$queryRaw.mock.calls[0][0];
  expect(query.sql.replace(/\s+/g, ' ').trim()).toBe(
    'SELECT "id" FROM "products" WHERE "tenantId" = ? AND "id" = ? FOR UPDATE',
  );
  expect(query.values).toEqual([tenantId, productId]);
  expect(s.tx.variant.findFirst).toHaveBeenCalledWith({
    where: { id: variantId, productId, tenantId },
    include: { product: { select: { useStock: true } } },
  });
  expect(s.tx.variant.update).toHaveBeenCalledWith({
    where: { id: variantId, productId, tenantId },
    data: { sku: 'SKU', barcode: 'bar', quantity: 9 },
  });
  expect(s.repo.isSkuTaken).toHaveBeenCalledWith(' sku ', { variantId });
  expect(s.repo.isBarcodeTaken).toHaveBeenCalledWith(' bar ', { variantId });
  expect(s.repo.rearmAlertAfterEdit).toHaveBeenCalledWith({
    productId,
    variantId,
  });
  expect(s.root.variant.findFirst).not.toHaveBeenCalled();
  expect(s.tenant.runInTransaction).toHaveBeenCalledTimes(1);
  expect(result).toEqual({
    ...s.row,
    sku: 'SKU',
    barcode: 'bar',
    quantity: 9,
    purchaseNetCostDecimal: null,
  });
});

it.each([
  'missing-parent',
  'foreign-parent',
  'missing-variant',
  'foreign-variant',
])('rejects %s without mutation', async (mode) => {
  const s = setup();
  if (mode.endsWith('parent')) s.tx.$queryRaw.mockResolvedValue([]);
  else s.tx.variant.findFirst.mockResolvedValue(null);
  const target = mode.startsWith('foreign') ? 'foreign-product' : productId;
  await expect(
    s.service.updateVariant(target, variantId, { quantity: 2 }),
  ).rejects.toEqual(new EntityNotFoundError('Variant', variantId));
  expect(s.tx.$queryRaw.mock.calls[0][0].values).toEqual([tenantId, target]);
  if (mode.endsWith('parent'))
    expect(s.tx.variant.findFirst).not.toHaveBeenCalled();
  else
    expect(s.tx.variant.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: variantId, productId: target, tenantId },
      }),
    );
  expect(s.tx.variant.update).not.toHaveBeenCalled();
  expect(s.repo.rearmAlertAfterEdit).not.toHaveBeenCalled();
  expect(s.events.at(-1)).toBe('rollback');
});

it.each(['gate', 'read', 'sku', 'barcode', 'update', 'rearm'])(
  'propagates %s failure and prevents subsequent operations',
  async (stage) => {
    const s = setup();
    const error = new Error(`${stage} failed`);
    const method = {
      gate: s.tx.$queryRaw,
      read: s.tx.variant.findFirst,
      sku: s.repo.isSkuTaken,
      barcode: s.repo.isBarcodeTaken,
      update: s.tx.variant.update,
      rearm: s.repo.rearmAlertAfterEdit,
    }[stage]!;
    method.mockRejectedValue(error);
    await expect(
      s.service.updateVariant(productId, variantId, {
        sku: 'SKU',
        barcode: 'BAR',
        quantity: 9,
      }),
    ).rejects.toBe(error);
    expect(s.events.at(-1)).toBe('rollback');
    expect(s.events).not.toContain('commit');
    expect(s.tx.variant.update).toHaveBeenCalledTimes(
      ['update', 'rearm'].includes(stage) ? 1 : 0,
    );
    expect(s.repo.rearmAlertAfterEdit).toHaveBeenCalledTimes(
      stage === 'rearm' ? 1 : 0,
    );
  },
);

it.each(['sku', 'barcode'] as const)(
  'keeps %s conflicts after the gate with no writes',
  async (key) => {
    const s = setup();
    (key === 'sku'
      ? s.repo.isSkuTaken
      : s.repo.isBarcodeTaken
    ).mockResolvedValue(true);
    await expect(
      s.service.updateVariant(productId, variantId, { [key]: 'TAKEN' }),
    ).rejects.toEqual(
      new EntityAlreadyExistsError(key === 'sku' ? 'SKU' : 'Barcode', 'TAKEN'),
    );
    expect(s.events.slice(0, 3)).toEqual(['begin', 'tx:gate', 'tx:read']);
    expect(s.tx.variant.update).not.toHaveBeenCalled();
    expect(s.repo.rearmAlertAfterEdit).not.toHaveBeenCalled();
  },
);

it('uses fresh post-gate parent stock and presentation when merging partial input', async () => {
  const s = setup();
  s.tx.$queryRaw.mockImplementation(() => {
    s.events.push('tx:gate');
    s.row.product.useStock = false;
    s.row.onlineStockPresentation = CatalogStockPresentation.CUSTOM_QUANTITY;
    s.row.onlineStockPresentationCustomQty = 4;
    return Promise.resolve([{ id: productId }]);
  });
  const result = await s.service.updateVariant(productId, variantId, {
    onlineStockPresentationCustomQty: 8,
    minQuantity: 3,
    name: ' New ',
  });
  expect(result).toMatchObject({
    name: 'New',
    minQuantity: 0,
    onlineStockPresentation: CatalogStockPresentation.CUSTOM_QUANTITY,
    onlineStockPresentationCustomQty: 8,
  });
  expect(s.repo.rearmAlertAfterEdit).toHaveBeenCalledTimes(1);
  expect(s.root.variant.findFirst).not.toHaveBeenCalled();
});

it('rejects freshly invalid merged presentation without writes or rearm', async () => {
  const s = setup();
  await expect(
    s.service.updateVariant(productId, variantId, {
      onlineStockPresentationCustomQty: 5,
    }),
  ).rejects.toBeInstanceOf(InvalidArgumentError);
  expect(s.events).toEqual(['begin', 'tx:gate', 'tx:read', 'rollback']);
  expect(s.tx.variant.update).not.toHaveBeenCalled();
  expect(s.repo.rearmAlertAfterEdit).not.toHaveBeenCalled();
});

it.each([
  CatalogPublishMode.ON,
  CatalogPublishMode.OFF,
  CatalogPublishMode.INHERIT,
  undefined,
])('coordinates mode %p with mixed stock edits', async (catalogPublishMode) => {
  const s = setup();
  const dto: UpdateVariantDto = {
    quantity: 6,
    minQuantity: 1,
    catalogPublishMode,
  };
  expect(
    await s.service.updateVariant(productId, variantId, dto),
  ).toMatchObject({
    catalogPublishMode: catalogPublishMode ?? CatalogPublishMode.INHERIT,
    quantity: 6,
    minQuantity: 1,
  });
  expect(s.events).toEqual([
    'begin',
    'tx:gate',
    'tx:read',
    'tx:update',
    'tx:rearm',
    'commit',
  ]);
  expect(
    Object.hasOwn(
      s.tx.variant.update.mock.calls[0][0].data,
      'catalogPublishMode',
    ),
  ).toBe(catalogPublishMode !== undefined);
});

it.each([null, 0, 1234])(
  'preserves cost %p and does not rearm non-stock edits',
  async (purchaseNetCostCents) => {
    const s = setup();
    // @IsOptional admits null for these wire fields despite the narrower DTO type.
    const dto = {
      purchaseNetCostCents,
      option: ' Size ',
      value: ' Large ',
      sku: null,
      barcode: null,
    } as unknown as UpdateVariantDto;
    const result = await s.service.updateVariant(productId, variantId, dto);
    expect(result).toMatchObject({
      name: 'Large',
      option: 'Size',
      value: 'Large',
      sku: null,
      barcode: null,
      purchaseNetCostCents,
      purchaseNetCostDecimal:
        purchaseNetCostCents === null ? null : purchaseNetCostCents / 100,
    });
    expect(s.events).toEqual([
      'begin',
      'tx:gate',
      'tx:read',
      'tx:update',
      'commit',
    ]);
    expect(s.repo.isSkuTaken).not.toHaveBeenCalled();
    expect(s.repo.isBarcodeTaken).not.toHaveBeenCalled();
    expect(s.repo.rearmAlertAfterEdit).not.toHaveBeenCalled();
  },
);
