import { readFileSync } from 'fs';
import { join } from 'path';
import type { PrismaClient } from '@prisma/client';
import ts from 'typescript';
import { createTenantScopedPrisma } from '../../shared/prisma/tenant-prisma.factory';
import { TENANT_SCOPED_MODELS } from '../../shared/tenant/tenant-scoped-models.constant';

const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
const models = [
  'ProcurementSupplier',
  'ProcurementSupplierAudit',
  'ProcurementSupplierReceipt',
];
const model = (name: string) =>
  schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
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

// Drift alarms only: PostgreSQL behavior is tested separately, never inferred here.
describe('supplier storage contract (offline drift checks)', () => {
  it.each(models)(
    '%s is explicitly tenant-scoped with restrictive identity retention',
    (name) => {
      expect(TENANT_SCOPED_MODELS.has(name)).toBe(true);
      expect(model(name)).toMatch(/tenantId\s+String/);
      expect(model(name)).toContain('onDelete: Restrict');
      expect(model(name)).not.toContain('onDelete: Cascade');
    },
  );

  it.each(models)(
    '%s receives tenant injection for reads and writes',
    async (model) => {
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
          model,
          operation,
          args: {
            where: { tenantId: 'tenant-b' },
            data: { tenantId: 'tenant-b' },
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

  it('keeps mutable supplier state separate from historical evidence', () => {
    expect(model('ProcurementSupplier')).toMatch(/version\s+Int\s+@default\(1\)/);
    expect(model('ProcurementSupplier')).toMatch(/termsText\s+String\?/);
    expect(model('ProcurementSupplierAudit')).toContain(
      '@@unique([tenantId, supplierId, supplierVersion]',
    );
    expect(model('ProcurementSupplierAudit')).toMatch(/snapshot\s+Json/);
    expect(model('ProcurementSupplierReceipt')).toMatch(/responseBody\s+Json/);
    expect(model('ProcurementSupplierReceipt')).toMatch(/requestHash\s+String/);
    expect(model('ProcurementSupplierReceipt')).toContain(
      '@@id([tenantId, actorId, operation, target, idempotencyKey]',
    );
  });

  it('typechecks the unexecuted integration spec against the isolated generated client', () => {
    const program = ts.createProgram(
      [join(__dirname, 'supplier-storage.integration.spec.ts')],
      {
        noEmit: true,
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        esModuleInterop: true,
        strictNullChecks: true,
        skipLibCheck: true,
        types: ['jest', 'node'],
      },
    );
    const errors = ts.getPreEmitDiagnostics(program).map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    );
    expect(errors).toEqual([]);
  });

  it('ships only additive supplier DDL and explicit SQL-only checks', () => {
    const sql = readFileSync(
      join(
        process.cwd(),
        'prisma/migrations/20261102090000_procurement_suppliers/migration.sql',
      ),
      'utf8',
    );
    expect(sql).not.toMatch(/^\s*(DROP|DELETE|TRUNCATE|UPDATE|INSERT|ALTER)\b/m);
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(3);
    for (const check of [
      'supplier_name_check',
      'supplier_terms_check',
      'supplier_version_check',
      'supplier_audit_version_check',
      'supplier_receipt_namespace_check',
      'supplier_receipt_key_check',
      'supplier_receipt_hash_check',
      'supplier_receipt_http_check',
    ]) {
      expect(sql).toContain(`CONSTRAINT "${check}" CHECK`);
    }
  });
});
