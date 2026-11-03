import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { PrismaClient } from '@prisma/client';
import { createTenantScopedPrisma } from '../../shared/prisma/tenant-prisma.factory';
import { TENANT_SCOPED_MODELS } from '../../shared/tenant/tenant-scoped-models.constant';

const schema = readFileSync(
  join(process.cwd(), 'prisma/schema.prisma'),
  'utf8',
);
const migration = join(
  process.cwd(),
  'prisma/migrations/20261104010000_procurement_purchase_order_drafts/migration.sql',
);
const sql = existsSync(migration) ? readFileSync(migration, 'utf8') : '';
const model = (name: string) =>
  schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
const models = [
  'ProcurementPurchaseOrder',
  'ProcurementPurchaseOrderLine',
  'ProcurementPurchaseOrderAudit',
  'ProcurementPurchaseOrderReceipt',
];

type ScopedArgs = {
  where?: Record<string, unknown>;
  data?: Record<string, unknown>;
};
type ScopeHook = (input: {
  model: string;
  operation: string;
  args: ScopedArgs;
  query: (args: ScopedArgs) => Promise<unknown>;
}) => Promise<unknown>;

describe('purchase-order draft storage (offline drift checks, not SQL execution)', () => {
  it.each(models)(
    '%s is tenant-owned and receives tenant injection',
    async (name) => {
      expect(model(name)).toMatch(/tenantId\s+String/);
      expect(model(name)).toContain('onDelete: Restrict');
      expect(TENANT_SCOPED_MODELS.has(name)).toBe(true);
      const extend = jest.fn(
        (extension: { query: { $allOperations: ScopeHook } }) => extension,
      );
      createTenantScopedPrisma(
        { $extends: extend } as unknown as PrismaClient,
        {
          get: (key: string) => (key === 'tenantId' ? 'tenant-a' : false),
        } as unknown as Parameters<typeof createTenantScopedPrisma>[1],
      );
      const hook = extend.mock.calls[0][0].query.$allOperations;
      for (const operation of [
        'findMany',
        'findUnique',
        'updateMany',
        'deleteMany',
        'create',
      ]) {
        const query = jest
          .fn<Promise<unknown>, [ScopedArgs]>()
          .mockResolvedValue([]);
        await hook({
          model: name,
          operation,
          args: {
            where: { tenantId: 'foreign' },
            data: { tenantId: 'foreign' },
          },
          query,
        });
        expect(
          query.mock.calls[0][0][operation === 'create' ? 'data' : 'where']
            ?.tenantId,
        ).toBe('tenant-a');
      }
    },
  );

  it('stores only drafts, optional supplier and ordered FE line identities', () => {
    expect(
      schema
        .match(/enum ProcurementPurchaseOrderStatus\s*\{([^}]+)\}/)?.[1]
        .trim(),
    ).toBe('DRAFT');
    const header = model(models[0]);
    expect(header).toMatch(/id\s+String\s+@id @default\(uuid\(\)\)/);
    expect(header).toMatch(/supplierId\s+String\?/);
    expect(header).toMatch(/version\s+Int\s+@default\(1\)/);
    for (const field of [
      'note',
      'locationDetail',
      'supplierDisplaySnapshot',
      'locationTenantName',
    ]) {
      expect(header).toContain(field);
    }
    expect(header).toContain(
      'fields: [tenantId, supplierId], references: [tenantId, id], onDelete: Restrict',
    );
    expect(model('ProcurementSupplier')).toContain('@@unique([tenantId, id])');
    const line = model(models[1]);
    expect(line).toContain('@@id([tenantId, orderId, lineId]');
    expect(line).toContain('@@unique([tenantId, orderId, position]');
    expect(line).toContain(
      'fields: [tenantId, orderId], references: [tenantId, id], onDelete: Cascade',
    );
    expect(line).not.toMatch(/\b(Product|Variant)\s+@relation/);
    for (const field of [
      'productId',
      'variantId',
      'orderedQuantity',
      'costAmount',
      'currency',
      'productName',
      'variantName',
    ]) {
      expect(line).toMatch(new RegExp(`${field}\\s+String\\?`));
    }
    expect(line).toMatch(/costUnit\s+UnitOfMeasure\?/);
    expect(line).toMatch(/unitSnapshot\s+UnitOfMeasure\?/);
    expect(line).toMatch(/informedUnitCostPresent\s+Boolean/);
    expect(line).not.toMatch(/\b(Float|Decimal)\b/);
  });

  it('retains actor, before/after evidence and original receipts without live order FKs', () => {
    for (const name of models.slice(2)) {
      expect(model(name)).toMatch(/orderId\s+String/);
      expect(model(name)).toMatch(/actorId\s+String/);
      expect(model(name)).not.toMatch(/\bProcurementPurchaseOrder\s+@relation/);
      expect(model(name)).not.toContain('onDelete: Cascade');
    }
    expect(schema).toMatch(
      /enum ProcurementPurchaseOrderOperation\s*\{\s*CREATE\s+REPLACE\s+DELETE\s*\}/,
    );
    expect(model(models[2])).toMatch(/beforeSnapshot\s+Json\?/);
    expect(model(models[2])).toMatch(/afterSnapshot\s+Json\?/);
    expect(model(models[2])).toContain(
      '@@unique([tenantId, orderId, orderVersion]',
    );
    expect(model(models[3])).toContain(
      '@@id([tenantId, actorId, operation, target, idempotencyKey]',
    );
    expect(model(models[3])).toMatch(/responseBody\s+Json/);
  });

  it('separates incomplete cost objects and preserves operation-specific evidence', () => {
    expect(sql).toContain('"informedUnitCostPresent" OR');
    expect(sql).toContain(
      '"costAmount" IS NULL AND "currency" IS NULL AND "costUnit" IS NULL AND "taxBasis" IS NULL',
    );
    expect(sql).not.toMatch(/"taxBasis"[^\n]*DEFAULT/);
    expect(sql).toContain(
      '"operation" = \'CREATE\' AND "beforeSnapshot" IS NULL',
    );
    expect(sql).toContain(
      '"operation" = \'REPLACE\' AND "beforeSnapshot" IS NOT NULL',
    );
    expect(sql).toContain(
      '"operation" = \'DELETE\' AND "beforeSnapshot" IS NOT NULL',
    );
    expect(sql).toContain('"afterSnapshot" IS NULL');
    expect(sql.match(/ON DELETE CASCADE/g)).toHaveLength(1);
    for (const table of ['audits', 'receipts']) {
      const evidence = sql
        .split(`CREATE TABLE "procurement_purchase_order_${table}"`)[1]
        ?.split(');')[0];
      expect(evidence).toBeDefined();
      expect(evidence).not.toContain(
        'REFERENCES "procurement_purchase_orders"',
      );
      expect(evidence).not.toContain('ON DELETE CASCADE');
      expect(evidence).toContain(
        'REFERENCES "tenants"("id") ON DELETE RESTRICT',
      );
    }
  });

  it('ships additive DDL with restrictive supplier FK and exact decimal/check boundaries', () => {
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(4);
    expect(sql).not.toMatch(
      /^\s*(DROP|DELETE|TRUNCATE|UPDATE|INSERT|ALTER)\b/m,
    );
    expect(sql).toContain(
      'FOREIGN KEY ("tenantId", "supplierId") REFERENCES "procurement_suppliers"("tenantId", "id") ON DELETE RESTRICT',
    );
    expect(sql).toContain('"currency" IS NULL OR "currency" = \'MXN\'');
    expect(sql).toContain("'^(0|[1-9][0-9]{0,8})(\\.[0-9]{1,3})?$'");
    expect(sql).toContain("'^(0|[1-9][0-9]{0,11})(\\.[0-9]{1,4})?$'");
    expect(sql).toContain('"orderedQuantity"::numeric > 0');
    for (const check of [
      'po_version',
      'po_note',
      'po_location',
      'po_line_position',
      'po_line_quantity',
      'po_line_amount',
      'po_line_currency',
      'po_audit_version',
      'po_audit_snapshots',
      'po_receipt_namespace',
      'po_receipt_key',
      'po_receipt_hash',
      'po_receipt_http',
    ]) {
      expect(sql).toContain(`CONSTRAINT "${check}_check" CHECK`);
    }
    expect(sql).toContain(
      '"statusCode" = 204 AND "responseBody" = \'null\'::jsonb',
    );
    expect(sql).toContain(
      '"operation" IN (\'REPLACE\', \'DELETE\') AND "target" = "orderId"',
    );
  });
});
