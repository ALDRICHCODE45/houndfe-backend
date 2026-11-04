/* eslint-disable @typescript-eslint/require-await -- Async Prisma mock boundary. */
import { Prisma } from '@prisma/client';
import { readPurchaseOrderReferences } from './po-references';
import type { OrderInput } from './po-contract';

const order: OrderInput = {
  supplierId: 'supplier',
  note: null,
  location: { detail: null },
  lines: ['z', 'a', 'z'].map((productId, index) => ({
    lineId: String(index),
    productId,
    variantId: `v${index}`,
    orderedQuantity: null,
    informedUnitCost: null,
  })),
};

describe('tenant-qualified purchase-order reference observation', () => {
  it('locks supplier then sorted unique products then sorted variants, without stock reads', async () => {
    const query = jest.fn(async (sql: Prisma.Sql) => {
      if (sql.sql.includes('procurement_suppliers'))
        return [
          { id: 'supplier', displayName: 'S', status: 'ARCHIVED', version: 7 },
        ];
      if (sql.sql.includes('FROM "products"'))
        return [
          {
            id: 'a',
            name: 'A',
            type: 'PRODUCT',
            unit: 'CAJA',
            hasVariants: true,
          },
          {
            id: 'z',
            name: 'Z',
            type: 'SERVICE',
            unit: 'HORA',
            hasVariants: false,
          },
        ];
      return [
        { id: 'v0', productId: 'a', name: 'Wrong parent' },
        { id: 'v1', productId: 'a', name: 'Valid variant' },
      ];
    });
    // SAFETY: reader only calls $queryRaw on the caller-owned transaction.
    const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
    const result = await readPurchaseOrderReferences(
      tx,
      'tenant',
      'Branch',
      order,
    );
    expect(query).toHaveBeenCalledTimes(3);
    const sql = query.mock.calls.map(([value]) => value);
    expect(sql[0].values).toEqual(['tenant', 'supplier']);
    expect(sql[0].sql).toContain('FOR UPDATE OF s');
    expect(sql[1].values).toEqual(['tenant', 'a', 'z']);
    expect(sql[1].sql).toContain('ORDER BY p."id" ASC FOR UPDATE OF p');
    expect(sql[2].values).toEqual(['tenant', 'v0', 'v1', 'v2']);
    expect(sql[2].sql).toContain(
      'ORDER BY v."productId" ASC, v."id" ASC FOR SHARE OF v',
    );
    expect(sql[0].sql).toContain('s."version"');
    expect(result.supplierVersion).toBe(7);
    expect(result.supplierDisplaySnapshot).toEqual({
      id: 'supplier',
      displayName: 'S',
      status: 'ARCHIVED',
    });
    expect(result.facts).toMatchObject({
      supplier: 'ARCHIVED',
      lines: {
        '0': {
          product: { type: 'SERVICE' },
          variant: { belongsToProduct: false },
        },
        '1': {
          product: { type: 'PRODUCT' },
          variant: { belongsToProduct: true },
        },
        '2': { variant: 'missing' },
      },
    });
    expect(result.lineDisplaySnapshots[0]).toEqual({
      lineId: '0',
      productName: null,
      variantName: null,
      unit: null,
    });
    expect(result.lineDisplaySnapshots[1]).toEqual({
      lineId: '1',
      productName: 'A',
      variantName: 'Valid variant',
      unit: 'CAJA',
    });
    expect(result.tenantName).toBe('Branch');
    expect(sql.every((value) => !value.sql.includes('quantity'))).toBe(true);
  });

  it('does not query unselected references or invent labels', async () => {
    const query = jest.fn();
    // SAFETY: no selected references means no transaction method is used.
    const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
    const result = await readPurchaseOrderReferences(tx, 'tenant', 'Branch', {
      supplierId: null,
      note: null,
      location: { detail: null },
      lines: [],
    });
    expect(query).not.toHaveBeenCalled();
    expect(result).toEqual({
      tenantName: 'Branch',
      facts: { supplier: 'missing', lines: {} },
      supplierVersion: null,
      supplierDisplaySnapshot: null,
      lineDisplaySnapshots: [],
    });
  });
});
