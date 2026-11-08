import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';

// File/DMMF-only: no PrismaClient, configuration loader, connection or migration.
const schema = readFileSync(join(__dirname, 'schema.prisma'), 'utf8');
const migration = readFileSync(
  join(
    __dirname,
    'migrations/20261108090000_sales_open_debt_cents/migration.sql',
  ),
  'utf8',
);

function block(name: string): string {
  return schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`))![1];
}

describe('Sale.openDebtCents generated column', () => {
  it('is a STORED generated column that zeroes canceled debt', () => {
    expect(migration).toContain(
      'ALTER TABLE "sales" ADD COLUMN "openDebtCents" INTEGER NOT NULL ' +
        'GENERATED ALWAYS AS (CASE WHEN "status" = \'CANCELED\' THEN 0 ' +
        'ELSE "debtCents" END) STORED;',
    );
  });

  it('indexes the debt sort per tenant', () => {
    expect(migration).toContain(
      'CREATE INDEX "sales_tenantId_openDebtCents_idx" ON "sales"("tenantId", "openDebtCents");',
    );
    expect(block('Sale')).toContain('@@index([tenantId, openDebtCents])');
  });

  it('is declared dbgenerated in the schema so the app never writes it', () => {
    const field = Prisma.dmmf.datamodel.models
      .find((model) => model.name === 'Sale')!
      .fields.find((entry) => entry.name === 'openDebtCents')!;

    expect(field.type).toBe('Int');
    expect(field.isRequired).toBe(true);
    expect(field.default).toEqual(
      expect.objectContaining({ name: 'dbgenerated' }),
    );
    expect(block('Sale')).toMatch(
      /openDebtCents\s+Int\s+@default\(dbgenerated\("CASE WHEN status = 'CANCELED'/,
    );
  });
});
