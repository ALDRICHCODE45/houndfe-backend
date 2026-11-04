import { readFileSync } from 'fs';
import { join } from 'path';
import { PERMISSION_REGISTRY } from '../auth/authorization/domain/permission';

const schema = readFileSync(
  join(process.cwd(), 'prisma/schema.prisma'),
  'utf8',
);
const sql = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261104020000_inventory_journal_storage/migration.sql',
  ),
  'utf8',
);
const model = (name: string) =>
  schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';

describe('inventory journal storage', () => {
  it('keeps movement ids as scalars so history survives deletes', () => {
    const movement = model('StockMovement');
    expect(movement).toContain('tenant Tenant @relation');
    expect(movement).not.toMatch(
      /@relation\(fields: \[(product|variant|lot)Id\]/,
    );
    expect(sql).not.toMatch(/"stock_movements_(product|variant|lot)Id_fkey"/);
    for (const column of [
      'delta',
      'balanceAfter',
      'productBalanceAfter',
      'productName',
      'variantLabel',
      'lotNumber',
      'actorDisplayName',
    ]) {
      expect(movement).toContain(column);
    }
  });

  it('indexes the kardex read and the group lookup', () => {
    expect(sql).toContain(
      'ON "stock_movements"("tenantId", "productId", "createdAt" DESC, "id" DESC)',
    );
    expect(sql).toContain(
      'ON "stock_movements"("tenantId", "groupType", "groupId")',
    );
  });

  it.each(['Product', 'Variant', 'Lot'])('adds stockVersion to %s', (name) => {
    expect(model(name)).toMatch(/stockVersion\s+Int\s+@default\(0\)/);
  });

  it('namespaces adjustment receipts like the procurement receipts', () => {
    expect(sql).toContain(
      'PRIMARY KEY ("tenantId","actorId","operation","target","idempotencyKey")',
    );
  });

  it('performs the S1 opening inside the migration', () => {
    expect(sql).toContain('p."quantity" < l."total"');
    expect(sql).toContain("'OPENING'");
    expect(sql).toContain("'Sistema'");
    expect(sql).toContain('WHERE b."qty" <> 0');
  });

  it('registers granular permissions with exactly one action each', () => {
    const rows = PERMISSION_REGISTRY.filter((p) =>
      ['InventoryJournal', 'InventoryAdjustment'].includes(p.subject),
    ).map((p) => `${p.action}:${p.subject}`);
    expect(rows.sort()).toEqual([
      'create:InventoryAdjustment',
      'read:InventoryJournal',
    ]);
  });
});
