// F1.WU1b — Migration drift guard for online-catalog-publishing.
// Compact, table-driven structural spec. Runs under `pnpm test` without
// PostgreSQL. Real-DB integration lives in
// `online-catalog-publishing-migration.integration.spec.ts`.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { seedOnlineCatalogDefaults } from './online-catalog-seed';

const REPO = process.cwd();
const readText = (p: string) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const SCHEMA = readText(`${REPO}/prisma/schema.prisma`);
const TENANT_SCOPED = readText(`${REPO}/src/shared/tenant/tenant-scoped-models.constant.ts`);
const CFG_PATH = `${REPO}/prisma/jest.online-catalog-migration.config.js`;

function findMigDir(): string | null {
  const root = `${REPO}/prisma/migrations`;
  if (!fs.existsSync(root)) return null;
  const e = fs.readdirSync(root, { withFileTypes: true }).map((d) => d.name).filter((n) => n.endsWith('_online_catalog_publishing')).sort().reverse();
  return e.length ? `${root}/${e[0]}` : null;
}
const migSQL = (): string => {
  const d = findMigDir();
  if (!d) throw new Error('migration not found');
  return fs.readFileSync(`${d}/migration.sql`, 'utf8');
};
const enumBody = (n: string) => SCHEMA.match(new RegExp(`^enum ${n}\\s*\\{([\\s\\S]*?)^\\}`, 'm'))?.[1] ?? '';
const modelBody = (m: string) => SCHEMA.match(new RegExp(`^model ${m}\\s*\\{([\\s\\S]*?)^\\}`, 'm'))?.[1] ?? '';

describe('online-catalog-publishing — drift guard (F1.WU1b)', () => {
  it('migration exists, is additive-only', () => {
    const d = findMigDir();
    expect(d).not.toBeNull();
    expect(fs.existsSync(path.join(d!, 'migration.sql'))).toBe(true);
    const s = migSQL();
    expect(s).not.toMatch(/DROP\s+COLUMN\b/i);
    expect(s).not.toMatch(/DROP\s+TABLE\s+"(?:products|variants|tenants|price_lists|variant_prices)"/i);
  });

  describe('enums + tenant-scoped + key fields', () => {
    it.each([
      ['CatalogPublishMode', ['INHERIT', 'ON', 'OFF']],
      ['CatalogStockPresentation', ['SYSTEM_STATUS', 'ABSTRACT_STATUS', 'CUSTOM_QUANTITY', 'HIDDEN']],
    ])('%s declares expected members', (name, members) => {
      for (const m of members) expect(enumBody(name)).toMatch(new RegExp(`\\b${m}\\b`));
    });
    it('TENANT_SCOPED_MODELS registers both new join models', () => {
      expect(TENANT_SCOPED).toMatch(/'TenantCatalogPriceList'/);
      expect(TENANT_SCOPED).toMatch(/'ProductCatalogPriceList'/);
    });
    it.each([
      ['Tenant catalogPublished false', 'Tenant', /catalogPublished\s+Boolean\s+@default\(false\)/],
      ['Tenant customQty nullable', 'Tenant', /catalogStockPresentationDefaultCustomQty\s+Int\?/],
      ['Variant publishMode DEFAULT INHERIT', 'Variant', /catalogPublishMode\s+CatalogPublishMode\s+@default\(INHERIT\)/],
      ['TCP @@unique (tenantId, globalPriceListId)', 'TenantCatalogPriceList', /@@unique\(\[\s*tenantId,\s*globalPriceListId\s*\]\)/],
      ['PCP @@unique (tenantId, productId, globalPriceListId)', 'ProductCatalogPriceList', /@@unique\(\[\s*tenantId,\s*productId,\s*globalPriceListId\s*\]\)/],
    ])('%s', (_l, model, re) => expect(modelBody(model)).toMatch(re));
  });

  describe('M1 — Tenant publication gate', () => {
    it('catalogPublished NOT NULL DEFAULT false on tenants', () => {
      expect(migSQL()).toMatch(/ALTER\s+TABLE\s+"tenants"\s+ADD\s+COLUMN\s+"catalogPublished"\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+false/i);
    });
    it('adds stock-presentation default + customQty to tenants', () => {
      const s = migSQL();
      expect(s).toMatch(/ADD\s+COLUMN\s+"catalogStockPresentationDefault"/);
      expect(s).toMatch(/ADD\s+COLUMN\s+"catalogStockPresentationDefaultCustomQty"/);
    });
  });

  describe('M3 — Variant publication mode', () => {
    it('backfills INHERIT then DEFAULT + NOT NULL', () => {
      const s = migSQL();
      expect(s).toMatch(/UPDATE\s+"variants"\s+SET\s+"catalogPublishMode"\s*=\s*['"]INHERIT['"]::"CatalogPublishMode"\s+WHERE\s+"catalogPublishMode"\s+IS\s+NULL/i);
      expect(s).toMatch(/ALTER\s+COLUMN\s+"catalogPublishMode"\s+SET\s+DEFAULT\s+['"]INHERIT['"]::"CatalogPublishMode"/i);
      expect(s).toMatch(/ALTER\s+COLUMN\s+"catalogPublishMode"\s+SET\s+NOT\s+NULL/i);
    });
  });

  describe('M4 — Default binding', () => {
    it('preflight rejects default_count > 1', () => {
      expect(migSQL()).toMatch(/default_count\s*>\s*1/i);
    });
    it('preflight rejects tenant_count > 0 AND default_count <> 1', () => {
      expect(migSQL()).toMatch(/tenant_count\s*>\s*0\s+AND\s+default_count\s*<>\s*1/i);
    });
    it('zero-tenant allowance: 0/0 must satisfy the IF guard (no raise)', () => {
      // IF (a > 1 OR (b > 0 AND a <> 1)) THEN ... — when a=0,b=0 both sides false.
      const cond = migSQL().match(/IF\s+(.+?)\s+THEN\s+RAISE\s+EXCEPTION/is)?.[1] ?? '';
      expect(cond).toMatch(/default_count/i);
      expect(cond).toMatch(/tenant_count/i);
    });
    it('RAISE message names GlobalPriceList', () => {
      expect(migSQL()).toMatch(/RAISE\s+EXCEPTION[^;]*GlobalPriceList/is);
    });
    it('idempotent: WHERE NOT EXISTS + ON CONFLICT DO NOTHING', () => {
      const s = migSQL();
      expect(s).toMatch(/NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+"tenant_catalog_price_lists"/i);
      expect(s).toMatch(/ON\s+CONFLICT\s*\(\s*"tenantId",\s*"globalPriceListId"\s*\)\s+DO\s+NOTHING/i);
    });
    it('INSERT lists isCatalogDefault + SELECT emits literal true', () => {
      const s = migSQL();
      expect(s).toMatch(/"isCatalogDefault"\s*,/);
      expect(s).toMatch(/\btrue\s*,/);
    });
  });

  describe('M5 + partial unique + CHECKs', () => {
    it('products backfilled to SYSTEM_STATUS where null', () => {
      expect(migSQL()).toMatch(/UPDATE\s+"products"\s+SET\s+"onlineStockPresentation"\s*=\s*['"]SYSTEM_STATUS['"]::"CatalogStockPresentation"\s+WHERE\s+"onlineStockPresentation"\s+IS\s+NULL/i);
    });
    it('variant stock columns added (null = inherit)', () => {
      const s = migSQL();
      expect(s).toMatch(/ADD\s+COLUMN\s+"onlineStockPresentation"\s+"?CatalogStockPresentation"?/i);
      expect(s).toMatch(/ADD\s+COLUMN\s+"onlineStockPresentationCustomQty"\s+INTEGER/i);
    });
    it('one-default-per-tenant partial unique index', () => {
      expect(migSQL()).toMatch(/CREATE\s+UNIQUE\s+INDEX[^;]+ON\s+"tenant_catalog_price_lists"\s*\(\s*"tenantId"\s*\)\s+WHERE\s+"isCatalogDefault"\s*=\s*true/i);
    });
    it.each([
      'tenants_catalog_stock_default_custom_qty_nonnegative',
      'products_online_stock_custom_qty_nonnegative',
      'variants_online_stock_custom_qty_nonnegative',
    ])('CHECK constraint %s', (name) => expect(migSQL()).toMatch(new RegExp(name, 'i')));
  });

  describe('SQL/Prisma alignment', () => {
    it.each([
      [/@@unique\(\[\s*tenantId,\s*globalPriceListId\s*\]\)/, /"tenant_catalog_price_lists_tenantId_globalPriceListId_key"/],
      [/@@unique\(\[\s*tenantId,\s*productId,\s*globalPriceListId\s*\]\)/, /"product_catalog_price_lists_tenantId_productId_globalPriceListId_key"/],
    ])('Prisma @@unique matches SQL unique index', (sRe, mRe) => {
      expect(SCHEMA).toMatch(sRe);
      expect(migSQL()).toMatch(mRe);
    });
  });

  describe('dedicated migration config', () => {
    function codeOnly(): string {
      const raw = fs.readFileSync(CFG_PATH, 'utf8');
      return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    }
    it('exists', () => expect(fs.existsSync(CFG_PATH)).toBe(true));
    it('declares NO globalSetup / globalTeardown / setupFiles', () => {
      const c = codeOnly();
      expect(c).not.toMatch(/globalSetup\s*:/);
      expect(c).not.toMatch(/globalTeardown\s*:/);
      expect(c).not.toMatch(/setupFiles\s*:/);
    });
    it('discovers only the integration spec file', () => {
      const c = codeOnly();
      expect(c).toMatch(/online-catalog-publishing-migration\.integration\.spec\.ts/);
      expect(c).not.toMatch(/migration-drift\.spec\.ts/);
      expect(c).not.toMatch(/online-catalog-seed\.ts/);
    });
  });
});

describe('seedOnlineCatalogDefaults helper (F1.WU1b)', () => {
  type Binding = { tenantId: string; globalPriceListId: string; isCatalogDefault: boolean };
  const fakeTx = (initial: Binding[] = []) => {
    const rows = [...initial];
    return {
      rows,
      tenantCatalogPriceList: {
        count: ({ where }: { where: { tenantId: string } }) =>
          Promise.resolve(rows.filter((b) => b.tenantId === where.tenantId).length),
        create: ({ data }: { data: Binding }) => {
          rows.push(data);
          return Promise.resolve(data);
        },
      },
    };
  };
  // Count = 0 → insert PUBLICO/default; count > 0 → preserve.
  it.each([
    ['count=0 inserts PUBLICO + isCatalogDefault=true', [], ['t-a', 't-b'], 'pub-id', [{ tenantId: 't-a', globalPriceListId: 'pub-id', isCatalogDefault: true }, { tenantId: 't-b', globalPriceListId: 'pub-id', isCatalogDefault: true }]],
    ['count>0 preserves admin binding', [{ tenantId: 't-admin', globalPriceListId: 'admin', isCatalogDefault: true }], ['t-admin'], 'pub', [{ tenantId: 't-admin', globalPriceListId: 'admin', isCatalogDefault: true }]],
    ['mixed batch: only zero-binding tenants get the binding', [{ tenantId: 't2', globalPriceListId: 'admin', isCatalogDefault: true }], ['t1', 't2', 't3'], 'pub', [{ tenantId: 't2', globalPriceListId: 'admin', isCatalogDefault: true }, { tenantId: 't1', globalPriceListId: 'pub', isCatalogDefault: true }, { tenantId: 't3', globalPriceListId: 'pub', isCatalogDefault: true }]],
  ])('%s', async (_l, initial, tenants, pub, expected) => {
    const tx = fakeTx(initial);
    await seedOnlineCatalogDefaults(tx as never, tenants, pub);
    expect(tx.rows).toEqual(expected);
  });
});