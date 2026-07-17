/**
 * Slice A.3 — Migration drift guard for low-stock-alerts.
 *
 * Per design.md "Migration plan (⚠ pre-existing drift mitigation)":
 *   - The migration MUST touch ONLY the 5 new objects
 *     (notification_settings, notification_recipients, notification_actions,
 *      stock_alert_states, NotificationActionKey enum).
 *   - The migration MUST NOT alter or DROP `employee_emergency_contacts` —
 *     the DB already has its `updatedAt` column; the schema drifted by
 *     dropping the field. Restoring `updatedAt DateTime @updatedAt` on the
 *     model makes schema match DB, so the migration emits NO drop.
 *
 * Structural spec (parse text), not unit: cheap to keep in TDD loop and
 * catches drift regressions if anyone hand-edits the generated migration.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('low-stock migration drift guard (A.3)', () => {
  // `process.cwd()` is the repo root when tests run via `pnpm test`
  // (Jest config: roots include `prisma/`, runner invoked from root).
  const repoRoot = process.cwd();
  const schemaPath = path.join(repoRoot, 'prisma', 'schema.prisma');
  const migrationsRoot = path.join(repoRoot, 'prisma', 'migrations');

  function findLowStockMigrationDir(): string | null {
    if (!fs.existsSync(migrationsRoot)) return null;
    const entries = fs
      .readdirSync(migrationsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => name.endsWith('_low_stock_alerts'));
    if (entries.length === 0) return null;
    return path.join(migrationsRoot, entries.sort().reverse()[0]);
  }

  const schemaText = (() => {
    try {
      return fs.readFileSync(schemaPath, 'utf8');
    } catch {
      return '';
    }
  })();

  it('schema declares all 4 new low-stock-alerts models', () => {
    expect(schemaText).toMatch(/^model NotificationSettings\s/m);
    expect(schemaText).toMatch(/^model NotificationRecipient\s/m);
    expect(schemaText).toMatch(/^model NotificationAction\s/m);
    expect(schemaText).toMatch(/^model StockAlertState\s/m);
  });

  it('schema declares the NotificationActionKey enum', () => {
    expect(schemaText).toMatch(/^enum NotificationActionKey\s/m);
    expect(schemaText).toMatch(/\bLOW_STOCK\b/);
  });

  it('schema restores updatedAt on EmployeeEmergencyContact (drift fix)', () => {
    // The previous schema dropped `updatedAt` while the DB still has the
    // column. Restoring it prevents the migration from emitting a DROP.
    const block = schemaText.match(
      /model EmployeeEmergencyContact\s*\{([\s\S]*?)\n\}/,
    );
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(/updatedAt\s+DateTime\s+@updatedAt/);
  });

  it('generated migration directory exists (low_stock_alerts)', () => {
    const dir = findLowStockMigrationDir();
    expect(dir).not.toBeNull();
    expect(fs.existsSync(path.join(dir!, 'migration.sql'))).toBe(true);
  });

  it('generated migration.sql touches ONLY the 5 new objects', () => {
    const dir = findLowStockMigrationDir();
    const sql = fs.readFileSync(
      path.join(dir!, 'migration.sql'),
      'utf8',
    );

    // Must reference every new object.
    expect(sql).toContain('notification_settings');
    expect(sql).toContain('notification_recipients');
    expect(sql).toContain('notification_actions');
    expect(sql).toContain('stock_alert_states');
    expect(sql).toContain('"NotificationActionKey"');
  });

  it('generated migration.sql does NOT alter employee_emergency_contacts', () => {
    const dir = findLowStockMigrationDir();
    const sql = fs.readFileSync(
      path.join(dir!, 'migration.sql'),
      'utf8',
    );

    // The pre-existing drift: DB has the column, model dropped it. If the
    // generated migration re-introduces a DROP / DROP COLUMN / ALTER for
    // `employee_emergency_contacts`, the drift fix has been undone.
    expect(sql).not.toMatch(/employee_emergency_contacts/);
  });

  it('generated migration.sql does NOT drop the updatedAt column on employee_emergency_contacts (drift) ', () => {
    // Belt + braces: even if the substring ever shows up for a benign
    // reason, an explicit DROP / DROP COLUMN must remain absent.
    const dir = findLowStockMigrationDir();
    const sql = fs.readFileSync(
      path.join(dir!, 'migration.sql'),
      'utf8',
    );
    expect(sql).not.toMatch(/DROP\s+COLUMN/i);
  });

  // ─── Slice 2 — Employee.userId retirement (hr-validation-notifications) ───
  // The destructive migration `retire_employee_userid` MUST remove the
  // identity link in `employees`: the `userId` column, the
  // `employees_userId_fkey` foreign key, the `employees_tenantId_userId_key`
  // unique index, and the `User.employees` back-relation. The schema and
  // the destructive migration MUST agree; this test pins both sides.
  describe('hr-validation-notifications — Employee.userId retirement (Slice 2)', () => {
    const employeesBlock = (() => {
      const m = schemaText.match(/model\s+Employee\s*\{([\s\S]*?)\n\}/);
      return m ? m[1] : '';
    })();
    const userBlock = (() => {
      const m = schemaText.match(/model\s+User\s*\{([\s\S]*?)\n\}/);
      return m ? m[1] : '';
    })();

    function findRetireMigrationDir(): string | null {
      const entries = fs
        .readdirSync(migrationsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((name) => name.endsWith('_retire_employee_userid'));
      if (entries.length === 0) return null;
      return path.join(migrationsRoot, entries.sort().reverse()[0]);
    }

    it('schema Employee model has NO userId column', () => {
      expect(employeesBlock).not.toMatch(/^\s*userId\s+/m);
    });

    it('schema Employee model has NO @@unique([tenantId, userId]) constraint', () => {
      expect(employeesBlock).not.toMatch(/@@unique\(\[tenantId,\s*userId\]\)/);
    });

    it('schema User model has NO `employees Employee[]` back-relation', () => {
      expect(userBlock).not.toMatch(/^\s*employees\s+Employee\[\]/m);
    });

    it('destructive migration retire_employee_userid drops the FK + index + column on employees ONLY', () => {
      const dir = findRetireMigrationDir();
      expect(dir).not.toBeNull();
      const sql = fs.readFileSync(path.join(dir!, 'migration.sql'), 'utf8');
      // The destructive path: drop FK, drop unique index, drop column.
      expect(sql).toMatch(/ALTER\s+TABLE\s+"employees"\s+DROP\s+CONSTRAINT\s+"employees_userId_fkey"/i);
      expect(sql).toMatch(/DROP\s+INDEX\s+"employees_tenantId_userId_key"/i);
      expect(sql).toMatch(/ALTER\s+TABLE\s+"employees"\s+DROP\s+COLUMN\s+"userId"/i);
      // Touches ONLY `employees` — the migration must NOT touch any
      // other table (e.g. notifications, users, tenants).
      const tableAlterations = sql.match(/ALTER\s+TABLE\s+"[a-z_]+"/gi) ?? [];
      expect(tableAlterations.length).toBeGreaterThanOrEqual(2); // FK + COLUMN
      for (const stmt of tableAlterations) {
        expect(stmt).toMatch(/ALTER\s+TABLE\s+"employees"/i);
      }
    });
  });
});
