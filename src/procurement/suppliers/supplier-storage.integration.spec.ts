import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { normalizeTestDatabaseUrl } from '../../../test/integration/setup/test-database-url';

// Parent runs ONLY on a newly owned disposable PostgreSQL target through the
// integration config. Its global setup migrates before this file executes.
const describeDb =
  process.env.SKIP_DB_INTEGRATION === '1' ? describe.skip : describe;
const rollback = new Error('supplier-storage-test-rollback');

describeDb('supplier storage PostgreSQL constraints', () => {
  let db: PrismaClient;
  beforeAll(() => {
    normalizeTestDatabaseUrl(process.env.DATABASE_URL, '[supplier-storage]');
    db = new PrismaClient();
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  async function fixture(tx: Prisma.TransactionClient, tenantId: string) {
    await tx.tenant.create({
      data: { id: tenantId, name: 'Storage proof', slug: tenantId },
    });
    const supplier = await tx.procurementSupplier.create({
      data: {
        tenantId,
        displayName: 'Original 😀',
        termsText: null,
        status: 'ACTIVE',
      },
    });
    const snapshot = {
      ...supplier,
      createdAt: supplier.createdAt.toISOString(),
      updatedAt: supplier.updatedAt.toISOString(),
    };
    const audit = {
      tenantId,
      supplierId: supplier.id,
      actorId: 'historical-actor',
      operation: 'CREATE' as const,
      supplierVersion: 1,
      snapshot,
    };
    await tx.procurementSupplierAudit.create({ data: audit });
    const receipt = {
      tenantId,
      supplierId: supplier.id,
      actorId: audit.actorId,
      operation: 'CREATE' as const,
      target: 'collection',
      idempotencyKey: ' key ',
      requestHash: 'a'.repeat(64),
      statusCode: 201,
      responseBody: snapshot,
    };
    await tx.procurementSupplierReceipt.create({ data: receipt });
    return { supplier, audit, receipt };
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>;
  type Write = (tx: Prisma.TransactionClient, f: Fixture) => Promise<unknown>;

  async function rejected(write: Write) {
    const tenantId = randomUUID();
    let fixtureReady = false;
    await expect(
      db.$transaction(async (tx) => {
        const f = await fixture(tx, tenantId);
        fixtureReady = true;
        await write(tx, f);
      }),
    ).rejects.toThrow();
    // Setup/missing-migration errors must not masquerade as constraint proof.
    expect(fixtureReady).toBe(true);
    expect(await db.procurementSupplier.count({ where: { tenantId } })).toBe(0);
    expect(
      await db.procurementSupplierAudit.count({ where: { tenantId } }),
    ).toBe(0);
    expect(
      await db.procurementSupplierReceipt.count({ where: { tenantId } }),
    ).toBe(0);
    expect(await db.tenant.count({ where: { id: tenantId } })).toBe(0);
  }

  it('supports full namespace reuse and preserves the original response after edits', async () => {
    await expect(
      db.$transaction(async (tx) => {
        const tenantId = randomUUID();
        const { supplier, receipt } = await fixture(tx, tenantId);
        const other = await fixture(tx, randomUUID());
        await tx.procurementSupplierReceipt.createMany({
          data: [
            { ...receipt, actorId: 'another-actor' },
            { ...receipt, idempotencyKey: 'key' }, // never trimmed
            {
              ...receipt,
              operation: 'UPDATE',
              target: supplier.id,
              statusCode: 200,
            },
          ],
        });
        const second = await tx.procurementSupplier.create({
          data: { tenantId, displayName: 'Second', status: 'ARCHIVED' },
        });
        await tx.procurementSupplierReceipt.create({
          data: {
            ...receipt,
            supplierId: second.id,
            operation: 'UPDATE',
            target: second.id,
            statusCode: 200,
          },
        });
        await tx.procurementSupplier.update({
          where: { id: supplier.id },
          data: {
            displayName: 'Changed',
            status: 'ARCHIVED',
            termsText: 'Later',
            version: 2,
          },
        });
        expect(
          await tx.procurementSupplierReceipt.count({ where: { tenantId } }),
        ).toBe(5);
        expect(
          await tx.procurementSupplierReceipt.count({
            where: { tenantId: other.supplier.tenantId },
          }),
        ).toBe(1);
        const original = await tx.procurementSupplierReceipt.findFirstOrThrow({
          where: {
            tenantId,
            actorId: receipt.actorId,
            operation: 'CREATE',
            target: 'collection',
            idempotencyKey: ' key ',
          },
        });
        expect(original.responseBody).toEqual(receipt.responseBody);
        expect(original.statusCode).toBe(201);
        const audit = await tx.procurementSupplierAudit.findFirstOrThrow({
          where: { tenantId },
        });
        expect(audit.snapshot).toEqual(receipt.responseBody);
        await tx.procurementSupplier.create({
          data: {
            tenantId,
            displayName: '😀'.repeat(200),
            termsText: '😀'.repeat(4000),
            status: 'ACTIVE',
          },
        }); // PostgreSQL counts codepoints, not JS UTF-16 units.
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it.each([
    ['blank name', { displayName: ' \t\u00a0\u2003\ufeff' }],
    ['long name', { displayName: '😀'.repeat(201) }],
    ['long terms', { termsText: '😀'.repeat(4001) }],
    ['zero version', { version: 0 }],
  ] satisfies Array<[string, Prisma.ProcurementSupplierUncheckedUpdateInput]>)(
    '%s rejects and conserves all tables',
    async (_name, data) => {
      await rejected((tx, f) =>
        tx.procurementSupplier.update({ where: { id: f.supplier.id }, data }),
      );
    },
  );

  it.each([
    ['duplicate receipt', {}],
    ['empty key', { idempotencyKey: '' }],
    ['long key', { idempotencyKey: 'k'.repeat(201) }],
    ['bad hash', { idempotencyKey: 'other', requestHash: 'not-sha256' }],
    ['wrong create target', { target: 'not-collection' }],
    ['wrong HTTP status', { idempotencyKey: 'other', statusCode: 200 }],
    ['wrong update target', { operation: 'UPDATE', statusCode: 200 }],
  ] satisfies Array<
    [string, Partial<Prisma.ProcurementSupplierReceiptUncheckedCreateInput>]
  >)('%s rejects and conserves all tables', async (_name, changes) => {
    await rejected((tx, f) =>
      tx.procurementSupplierReceipt.create({
        data: { ...f.receipt, ...changes },
      }),
    );
  });

  it.each([1, -1])(
    'audit version %s rejects duplicate/nonpositive writes',
    async (supplierVersion) => {
      await rejected((tx, f) =>
        tx.procurementSupplierAudit.create({
          data: { ...f.audit, supplierVersion },
        }),
      );
    },
  );

  it.each(['audit', 'receipt'] as const)(
    '%s retains its restrictive tenant FK even without a live supplier FK',
    async (kind) => {
      await rejected(async (tx, f) => {
        const tenantId = randomUUID(); // nonexistent tenant, not a live-supplier relation
        return kind === 'audit'
          ? tx.procurementSupplierAudit.create({
              data: { ...f.audit, tenantId },
            })
          : tx.procurementSupplierReceipt.create({
              data: { ...f.receipt, tenantId, idempotencyKey: 'other' },
            });
      });
    },
  );

  it('tenant deletion cannot erase evidence', async () => {
    await rejected(async (tx, f) => {
      await tx.procurementSupplier.deleteMany({
        where: { tenantId: f.supplier.tenantId, id: f.supplier.id },
      });
      return tx.tenant.delete({ where: { id: f.supplier.tenantId } });
    });
  });

  it('hard deletion preserves scalar IDs, all snapshots/receipts and tenant restrictions', async () => {
    await expect(
      db.$transaction(async (tx) => {
        const tenantId = randomUUID();
        const f = await fixture(tx, tenantId);
        const audits = await tx.procurementSupplierAudit.findMany({
          where: { tenantId },
        });
        const receipts = await tx.procurementSupplierReceipt.findMany({
          where: { tenantId },
        });
        await tx.procurementSupplier.deleteMany({
          where: { tenantId, id: f.supplier.id, version: 1 },
        });
        expect(
          await tx.procurementSupplier.count({ where: { tenantId } }),
        ).toBe(0);
        expect(
          await tx.procurementSupplierAudit.findMany({ where: { tenantId } }),
        ).toEqual(audits);
        expect(
          await tx.procurementSupplierReceipt.findMany({ where: { tenantId } }),
        ).toEqual(receipts);
        await tx.procurementSupplierReceipt.create({
          data: {
            ...f.receipt,
            operation: 'DELETE',
            target: f.supplier.id,
            statusCode: 204,
            responseBody: Prisma.JsonNull,
          },
        });
        expect(
          (
            await tx.procurementSupplierReceipt.findFirstOrThrow({
              where: { tenantId, operation: 'DELETE' },
            })
          ).responseBody,
        ).toBeNull();
        const constraints = await tx.$queryRaw<
          { conname: string }[]
        >`SELECT conname FROM pg_constraint WHERE conname IN ('supplier_audit_tenant_fk', 'supplier_receipt_tenant_fk', 'supplier_audit_supplier_fk', 'supplier_receipt_supplier_fk')`;
        expect(constraints.map((c) => c.conname).sort()).toEqual([
          'supplier_audit_tenant_fk',
          'supplier_receipt_tenant_fk',
        ]);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it.each([
    [
      'wrong delete target',
      {
        operation: 'DELETE',
        target: 'collection',
        statusCode: 204,
        responseBody: Prisma.JsonNull,
      },
    ],
    [
      'wrong delete status',
      {
        operation: 'DELETE',
        target: 'same-as-supplier',
        statusCode: 200,
        responseBody: Prisma.JsonNull,
      },
    ],
    [
      'nonempty delete response',
      {
        operation: 'DELETE',
        target: 'same-as-supplier',
        statusCode: 204,
        responseBody: {},
      },
    ],
  ] satisfies Array<
    [string, Partial<Prisma.ProcurementSupplierReceiptUncheckedCreateInput>]
  >)('%s rejects atomically', async (_name, changes) => {
    await rejected((tx, f) =>
      tx.procurementSupplierReceipt.create({
        data: {
          ...f.receipt,
          ...changes,
          target:
            changes.target === 'same-as-supplier'
              ? f.supplier.id
              : f.receipt.target,
        },
      }),
    );
  });
});
