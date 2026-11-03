'use strict';
// Parent-only executable. Imports are inert; no retries, resume, installs or cleanup.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  ROOT,
  LABEL,
  proofEnvironment,
  validateTarget,
  validateIdentity,
  validateEmptySchema,
  IDENTITY_SQL,
} = require('../supplier-runtime/verify-delete-migration.cjs');
const {
  validateTarget: validateManifest,
} = require('../supplier-runtime/host.cjs');
const FORWARD = '20261104010000_procurement_purchase_order_drafts';
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const check = (condition) => assert(condition, 'Safety precondition rejected');
function redact(output, secrets = []) {
  for (const value of secrets.filter(Boolean))
    output = output.split(value).join('[REDACTED]');
  return output.replace(
    /postgres(?:ql)?:\/\/[^\s"']+/g,
    '[REDACTED DATABASE URL]',
  );
}
function splitMigrations(files) {
  check(files.includes('prisma/migrations/migration_lock.toml'));
  for (const file of files)
    check(
      /^prisma\/migrations\/(migration_lock\.toml|[0-9a-z_]+\/migration\.sql)$/.test(
        file,
      ),
    );
  const forward = `prisma/migrations/${FORWARD}/migration.sql`;
  check(files.includes(forward));
  check(
    files
      .filter((f) => f.endsWith('/migration.sql'))
      .every((f) => f <= forward),
  );
  return { baseline: files.filter((f) => f !== forward), forward };
}
function verifyAdditive(before, after) {
  // These are catalog/data projections of EVERY pre-existing public table.
  assert.deepEqual(after, before);
}
async function expectSqlError(db, sql, values, code, constraint) {
  let caught;
  try {
    await db.query(sql, values);
  } catch (error) {
    caught = error;
  }
  check(caught && caught.code === code && caught.constraint === constraint);
  return { code: caught.code, constraint: caught.constraint };
}
async function directProof(db, prisma, pin, observe = () => {}) {
  await pin();
  const tenant = crypto.randomUUID(),
    supplier = crypto.randomUUID(),
    order = crypto.randomUUID();
  await db.query(
    'INSERT INTO tenants (id,name,slug,"updatedAt") VALUES ($1,$1,$1,now())',
    [tenant],
  );
  await db.query(
    'INSERT INTO procurement_suppliers (id,"tenantId","displayName",status,"updatedAt") VALUES ($1,$2,$1,\'ACTIVE\',now())',
    [supplier, tenant],
  );
  await db.query(
    'INSERT INTO procurement_purchase_orders (id,"tenantId","supplierId","locationTenantName","updatedAt") VALUES ($1,$2,$3,$2,now())',
    [order, tenant, supplier],
  );
  const insert = `INSERT INTO procurement_purchase_order_lines
    ("tenantId","orderId","lineId",position,"orderedQuantity","informedUnitCostPresent","costAmount",currency)
    VALUES ($1,$2,$3,0,$4,$5,$6,$7)`;
  const errors = [];
  const otherTenant = crypto.randomUUID();
  await db.query(
    'INSERT INTO tenants (id,name,slug,"updatedAt") VALUES ($1,$1,$1,now())',
    [otherTenant],
  );
  errors.push(
    await expectSqlError(
      db,
      'INSERT INTO procurement_purchase_orders (id,"tenantId","supplierId","locationTenantName","updatedAt") VALUES ($1,$2,$3,$2,now())',
      [crypto.randomUUID(), otherTenant, supplier],
      '23503',
      'po_supplier_fk',
    ),
  );
  for (const [quantity, present, amount, currency, constraint] of [
    ['1', true, '1', 'USD', 'po_line_currency_check'],
    ['0', true, '1', 'MXN', 'po_line_quantity_check'],
    ['01', true, '1', 'MXN', 'po_line_quantity_check'],
    ['1.0001', true, '1', 'MXN', 'po_line_quantity_check'],
    ['1e2', true, '1', 'MXN', 'po_line_quantity_check'],
    ['1', true, '-1', 'MXN', 'po_line_amount_check'],
    ['1', true, '01', 'MXN', 'po_line_amount_check'],
    ['1', true, '1.00001', 'MXN', 'po_line_amount_check'],
    ['1', false, '0', null, 'po_line_cost_presence_check'],
  ])
    errors.push(
      await expectSqlError(
        db,
        insert,
        [
          tenant,
          order,
          crypto.randomUUID(),
          quantity,
          present,
          amount,
          currency,
        ],
        '23514',
        constraint,
      ),
    );
  await db.query(insert, [
    tenant,
    order,
    crypto.randomUUID(),
    '12.5',
    true,
    '10.2500',
    'MXN',
  ]);
  errors.push(
    await expectSqlError(
      db,
      'DELETE FROM procurement_suppliers WHERE id=$1 AND "tenantId"=$2',
      [supplier, tenant],
      '23503',
      'po_supplier_fk',
    ),
  );
  let prismaError;
  try {
    await prisma.procurementSupplier.deleteMany({
      where: { tenantId: tenant, id: supplier },
    });
  } catch (error) {
    prismaError = error;
  }
  check(prismaError?.code === 'P2003');
  // Preserve only the bounded constraint name, never the message/stack/target.
  // Prisma 6.19 reports it as meta.constraint (observed on PostgreSQL).
  const constraint = prismaError.meta?.constraint;
  observe({
    code: 'P2003',
    constraint:
      typeof constraint === 'string' &&
      /^[a-zA-Z0-9_ ()-]{1,200}$/.test(constraint)
        ? constraint
        : null,
  });
  check(constraint === 'po_supplier_fk');
  await db.query(
    `INSERT INTO procurement_purchase_order_audits
    (id,"tenantId","orderId","actorId",operation,"orderVersion","afterSnapshot") VALUES ($1,$2,$3,'proof','CREATE',1,'{}');
  `.trim(),
    [crypto.randomUUID(), tenant, order],
  );
  await db.query(
    `INSERT INTO procurement_purchase_order_receipts
    ("tenantId","actorId",operation,target,"idempotencyKey","orderId","requestHash","statusCode","responseBody")
    VALUES ($1,'proof','CREATE','collection','proof',$2,$3,201,'{}')`,
    [tenant, order, 'a'.repeat(64)],
  );
  const evidence = async () =>
    (
      await db.query(
        `SELECT 'audit' AS kind,to_jsonb(t)::text AS record FROM procurement_purchase_order_audits t WHERE "tenantId"=$1
    UNION ALL SELECT 'receipt',to_jsonb(t)::text FROM procurement_purchase_order_receipts t WHERE "tenantId"=$1 ORDER BY kind,record`,
        [tenant],
      )
    ).rows;
  const before = await evidence();
  check(before.length === 2);
  check(
    (
      await db.query(
        'SELECT count(*)::int AS n FROM procurement_purchase_order_lines WHERE "tenantId"=$1 AND "orderId"=$2',
        [tenant, order],
      )
    ).rows[0].n === 1,
  );
  await db.query(
    'DELETE FROM procurement_purchase_orders WHERE id=$1 AND "tenantId"=$2',
    [order, tenant],
  );
  check(
    (
      await db.query(
        'SELECT count(*)::int AS n FROM procurement_purchase_order_lines WHERE "tenantId"=$1 AND "orderId"=$2',
        [tenant, order],
      )
    ).rows[0].n === 0,
  );
  assert.deepEqual(await evidence(), before);
  // Remove only this proof's live supplier so ONLY durable PO evidence can block tenant deletion.
  await db.query(
    'DELETE FROM procurement_suppliers WHERE id=$1 AND "tenantId"=$2',
    [supplier, tenant],
  );
  let tenantError;
  try {
    await db.query('DELETE FROM tenants WHERE id=$1', [tenant]);
  } catch (error) {
    tenantError = error;
  }
  check(
    tenantError?.code === '23503' &&
      ['po_audit_tenant_fk', 'po_receipt_tenant_fk'].includes(
        tenantError.constraint,
      ),
  );
  errors.push({ code: tenantError.code, constraint: tenantError.constraint });
  return {
    errors,
    prisma: { code: 'P2003', constraint },
    lineCascade: true,
    evidencePreserved: true,
    tenantRestrict: true,
  };
}
async function main() {
  check(process.argv.length === 2);
  check(
    fs.realpathSync(process.cwd()) === ROOT && fs.realpathSync(ROOT) === ROOT,
  );
  check(fs.statSync(path.join(ROOT, '.git')).isFile());
  const temporary = path.join(ROOT, '.tmp');
  const temporaryStat = fs.lstatSync(temporary);
  check(
    fs.realpathSync(temporary) === temporary &&
      !temporaryStat.isSymbolicLink() &&
      temporaryStat.isDirectory() &&
      temporaryStat.uid === process.getuid(),
  );
  for (const file of ['.env', '.env.test', 'prisma/.env'])
    check(!fs.existsSync(path.join(ROOT, file)));
  const directory = fs.mkdtempSync(path.join(ROOT, '.tmp/po-migration-proof.'));
  fs.chmodSync(directory, 0o700);
  const save = (name, value) =>
    fs.writeFileSync(
      path.join(directory, name),
      JSON.stringify(value, null, 2) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
  const result = { state: 'preflight', commands: [], resourcesRetained: true };
  const env = proofEnvironment(directory);
  env.CHECKPOINT_DISABLE = '1';
  env.PRISMA_HIDE_UPDATE_MESSAGE = '1';
  process.env = { ...env };
  let password, url, db, prisma;
  const run = (label, command, args, raw = false) => {
    const response = spawnSync(command, args, {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      timeout: 300000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const output = (response.stdout || '') + (response.stderr || '');
    const step = {
      label,
      status: response.status,
      signal: response.signal,
      spawnError: response.error?.code || null,
    };
    result.commands.push(step);
    const stem = `${String(result.commands.length).padStart(3, '0')}-${label}`;
    fs.writeFileSync(
      path.join(directory, `${stem}.log`),
      redact(output, [password, url]),
      { mode: 0o600, flag: 'wx' },
    );
    save(`${stem}.json`, step);
    check(!response.error && !response.signal && response.status === 0);
    return raw ? response.stdout : response.stdout.trim();
  };
  const docker = (label, args) =>
    run(label, 'docker', ['--host', 'unix:///var/run/docker.sock', ...args]);
  try {
    check(
      run('canonical-root', 'git', ['rev-parse', '--show-toplevel']) === ROOT,
    );
    check(
      path.resolve(
        ROOT,
        run('common-dir', 'git', ['rev-parse', '--git-common-dir']),
      ) !== path.join(ROOT, '.git'),
    );
    check(require('prisma/package.json').version.startsWith('6.'));
    const cli = require.resolve('prisma/build/index.js');
    const jest = require.resolve('jest/bin/jest');
    const token = crypto.randomBytes(16).toString('hex');
    const owner = {
      root: ROOT,
      token,
      name: `houndfe-po-${token}`,
      network: `houndfe-po-${token}-net`,
      user: `proof_${token}`,
      database: 'nest-practice-test',
    };
    password = crypto.randomBytes(32).toString('hex');
    owner.imageId = JSON.parse(
      docker('cached-image', ['image', 'inspect', 'postgres:17']),
    )[0].Id;
    save('ownership-planned.json', owner);
    result.state = 'network-create';
    owner.networkId = docker('network-create', [
      'network',
      'create',
      '--internal',
      '--label',
      `${LABEL}=${token}`,
      owner.network,
    ]);
    save('ownership-network.json', owner);
    result.state = 'container-create';
    owner.containerId = docker('container-create', [
      'create',
      '--pull=never',
      '--name',
      owner.name,
      '--label',
      `${LABEL}=${token}`,
      '--network',
      owner.network,
      '--read-only',
      '--tmpfs',
      '/var/lib/postgresql/data:rw,nosuid,nodev',
      '--tmpfs',
      '/var/run/postgresql:rw,nosuid,nodev',
      '--env',
      `POSTGRES_USER=${owner.user}`,
      '--env',
      `POSTGRES_PASSWORD=${password}`,
      '--env',
      `POSTGRES_DB=${owner.database}`,
      'postgres:17',
    ]);
    save('ownership-container.json', owner);
    docker('container-start', ['start', owner.containerId]);
    // One bounded startup pause, then exactly one readiness observation. Failure is final.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    owner.ip = JSON.parse(
      docker('container-inspect', ['inspect', owner.containerId]),
    )[0].NetworkSettings.Networks[owner.network]?.IPAddress;
    url = `postgresql://${owner.user}:${password}@${owner.ip}:5432/${owner.database}`;
    const guard = () =>
      validateTarget(
        owner,
        JSON.parse(
          docker('container-inspect', ['inspect', owner.containerId]),
        )[0],
        JSON.parse(
          docker('network-inspect', ['network', 'inspect', owner.networkId]),
        )[0],
        url,
        fs.realpathSync(process.cwd()),
      );
    guard();
    const identity = {
      database: owner.database,
      username: owner.user,
      ip: owner.ip,
    };
    validateManifest(identity, url);
    save('ownership.json', owner);
    save('target-identity.json', identity);
    save('target.json', { url });
    env.DATABASE_URL = url;
    process.env.DATABASE_URL = url;
    result.state = 'readiness';
    docker('readiness', [
      'exec',
      owner.containerId,
      'pg_isready',
      '-h',
      '127.0.0.1',
      '-U',
      owner.user,
      '-d',
      owner.database,
    ]);
    const { Client } = require('pg');
    db = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    await db.connect();
    const pin = async () => {
      guard();
      validateIdentity((await db.query(IDENTITY_SQL)).rows[0], owner);
    };
    await pin();
    validateEmptySchema(
      (
        await db.query(`SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='public') AS public_exists,
      EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace UNION ALL SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace UNION ALL SELECT 1 FROM pg_type WHERE typnamespace='public'::regnamespace) AS public_nonempty,
      EXISTS(SELECT 1 FROM pg_class WHERE relname='_prisma_migrations') AS ledger_present`)
      ).rows[0],
    );
    const files = run('migration-tree', 'git', [
      'ls-tree',
      '-r',
      '--name-only',
      'HEAD',
      '--',
      'prisma/migrations',
    ]).split('\n');
    const { baseline, forward } = splitMigrations(files);
    assert.deepEqual(
      fs.readdirSync(path.join(ROOT, 'prisma/migrations')).sort(),
      [
        'migration_lock.toml',
        ...files
          .filter((f) => f.endsWith('/migration.sql'))
          .map((f) => f.split('/')[2]),
      ].sort(),
    );
    const schemaDir = path.join(directory, 'prisma');
    fs.mkdirSync(path.join(schemaDir, 'migrations'), {
      recursive: true,
      mode: 0o700,
    });
    fs.writeFileSync(
      path.join(schemaDir, 'schema.prisma'),
      fs.readFileSync(path.join(ROOT, 'prisma/schema.prisma')),
      { flag: 'wx', mode: 0o600 },
    );
    const hashes = {};
    const copy = (file) => {
      const content = run(
        'migration-read',
        'git',
        ['show', `HEAD:${file}`],
        true,
      );
      const original = fs.readFileSync(path.join(ROOT, file));
      check(original.equals(Buffer.from(content)));
      hashes[file] = sha(original);
      const dest = path.join(schemaDir, path.relative('prisma', file));
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.writeFileSync(dest, original, { flag: 'wx', mode: 0o600 });
    };
    const deploy = async () => {
      await pin();
      run('migrate-deploy', process.execPath, [
        cli,
        'migrate',
        'deploy',
        '--schema',
        path.join(schemaDir, 'schema.prisma'),
      ]);
    };
    for (const file of baseline) copy(file);
    result.state = 'baseline';
    await deploy();
    const tables = (
      await db.query(
        `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' ORDER BY tablename`,
      )
    ).rows.map((r) => r.tablename);
    result.state = 'preservation-seed';
    await pin();
    const tenant = crypto.randomUUID(),
      supplier = crypto.randomUUID(),
      product = crypto.randomUUID();
    await db.query(
      'INSERT INTO tenants (id,name,slug,"updatedAt") VALUES ($1,$1,$1,now())',
      [tenant],
    );
    await db.query(
      'INSERT INTO procurement_suppliers (id,"tenantId","displayName",status,"updatedAt") VALUES ($1,$2,$1,\'ACTIVE\',now())',
      [supplier, tenant],
    );
    await db.query(
      'INSERT INTO products (id,"tenantId",name,"updatedAt") VALUES ($1,$2,$1,now())',
      [product, tenant],
    );
    const snapshot = async () => {
      const rows = {};
      for (const table of tables) {
        check(/^[a-zA-Z0-9_]+$/.test(table));
        // PostgreSQL quotes the catalog-derived identifier with %I; values stay bound.
        const statement = (
          await db.query('SELECT format($1::text, $2::text) AS sql', [
            'SELECT to_jsonb(t)::text AS record FROM %I t ORDER BY to_jsonb(t)::text',
            table,
          ])
        ).rows[0].sql;
        const data = (await db.query(statement)).rows;
        const columns = (
          await db.query(
            "SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
            [table],
          )
        ).rows;
        const constraints = (
          await db.query(
            `SELECT conname,contype,convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass ORDER BY conname`,
            [table],
          )
        ).rows;
        const indexes = (
          await db.query(
            "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=$1 ORDER BY indexname",
            [table],
          )
        ).rows;
        rows[table] = {
          count: data.length,
          dataHash: sha(JSON.stringify(data)),
          columns,
          constraints,
          indexes,
        };
      }
      return rows;
    };
    const before = await snapshot();
    save('before.json', before);
    const ledger = async () =>
      (
        await db.query(
          'SELECT migration_name,checksum,finished_at IS NOT NULL AS finished,rolled_back_at IS NOT NULL AS rolled_back FROM "_prisma_migrations" ORDER BY migration_name',
        )
      ).rows;
    const baselineLedger = await ledger();
    copy(forward);
    result.state = 'forward';
    await deploy();
    const after = await snapshot();
    save('after.json', after);
    verifyAdditive(before, after);
    const finalLedger = await ledger();
    save('ledger.json', finalLedger);
    save('hashes.json', hashes);
    assert.deepEqual(
      finalLedger.filter((r) => r.migration_name !== FORWARD),
      baselineLedger,
    );
    check(
      finalLedger.length ===
        files.filter((f) => f.endsWith('/migration.sql')).length,
    );
    check(
      finalLedger.every(
        (r) =>
          r.finished &&
          !r.rolled_back &&
          r.checksum ===
            hashes[`prisma/migrations/${r.migration_name}/migration.sql`],
      ),
    );
    result.preservation = true;
    result.state = 'sql-constraints';
    prisma = new (require('@prisma/client').PrismaClient)({
      datasources: { db: { url } },
    });
    result.constraints = await directProof(db, prisma, pin, (value) =>
      save('prisma-fk-observation.json', value),
    );
    await prisma.$disconnect();
    prisma = null;
    result.state = 'integration';
    const specs = ['purchase-orders', 'suppliers'].flatMap((folder) =>
      fs
        .readdirSync(path.join(ROOT, 'src/procurement', folder))
        .filter((f) => f.endsWith('.integration.spec.ts'))
        .sort()
        .map((f) => `src/procurement/${folder}/${f}`),
    );
    check(specs.length === 5);
    for (const spec of specs) {
      await pin();
      for (const file of ['.env', '.env.test', 'prisma/.env'])
        check(!fs.existsSync(path.join(ROOT, file)));
      run(
        `integration-${path.basename(spec, '.integration.spec.ts')}`,
        process.execPath,
        [
          jest,
          '--config',
          'jest.integration.config.js',
          '--runInBand',
          '--no-cache',
          '--runTestsByPath',
          spec,
        ],
      );
    }
    result.state = 'passed';
  } catch {
    result.failedAt = result.state;
    result.state = 'failed';
    process.exitCode = 1;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    if (db) await db.end().catch(() => {});
    save('results.json', result);
    console.log(
      `PO proof ${result.state}; retained ${path.relative(ROOT, directory)}`,
    );
  }
}
module.exports = {
  splitMigrations,
  verifyAdditive,
  expectSqlError,
  directProof,
  redact,
  FORWARD,
};
if (require.main === module)
  main().catch(() => {
    console.error('PO proof preflight rejected');
    process.exitCode = 1;
  });
