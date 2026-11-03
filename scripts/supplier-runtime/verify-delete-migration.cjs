'use strict';
// Parent-executed only. Retains every resource on success/failure.
// No generation/install command; integration globalSetup must also use installed CLI.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../..');
const FORWARD = [
  '20261103010000_supplier_delete_operation',
  '20261103010100_supplier_delete_evidence',
];
const TABLES = [
  'procurement_suppliers',
  'procurement_supplier_audits',
  'procurement_supplier_receipts',
];
const LABEL = 'houndfe.delete-migration-proof';
const digest = (s) => crypto.createHash('sha256').update(s).digest('hex');
const check = (ok) => {
  if (!ok) throw new Error('Safety precondition rejected');
};

function validateTarget(owner, container, network, rawUrl, cwd) {
  check(
    cwd === ROOT &&
      owner.root === ROOT &&
      /^[a-f0-9]{64}$/.test(owner.containerId) &&
      /^[a-f0-9]{64}$/.test(owner.networkId),
  );
  check(
    container.Id === owner.containerId &&
      container.Name === `/${owner.name}` &&
      container.State.Running,
  );
  check(
    container.Config.Image === 'postgres:17' &&
      container.Image === owner.imageId &&
      /^sha256:[a-f0-9]{64}$/.test(owner.imageId) &&
      container.Config.Labels?.[LABEL] === owner.token,
  );
  check(
    network.Id === owner.networkId &&
      network.Name === owner.network &&
      network.Internal === true &&
      network.Labels?.[LABEL] === owner.token,
  );
  const members = Object.keys(network.Containers || {});
  check(members.length === 1 && members[0] === owner.containerId);
  const attachments = Object.entries(container.NetworkSettings.Networks || {});
  check(attachments.length === 1 && attachments[0][0] === owner.network);
  const attached = attachments[0][1];
  check(
    attached.NetworkID === owner.networkId &&
      attached.IPAddress === owner.ip &&
      /^\d+\.\d+\.\d+\.\d+$/.test(owner.ip),
  );
  check(
    network.Containers[owner.containerId].IPv4Address.split('/')[0] ===
      owner.ip,
  );
  const host = container.HostConfig;
  check(
    !host.Privileged &&
      !host.PublishAllPorts &&
      !(host.Binds || []).length &&
      Object.keys(host.PortBindings || {}).length === 0,
  );
  check(host.NetworkMode === owner.network && host.ReadonlyRootfs === true);
  check(
    Object.keys(host.Tmpfs || {})
      .sort()
      .join(',') === '/var/lib/postgresql/data,/var/run/postgresql',
  );
  check(
    (container.Mounts || []).every((m) => m.Type === 'tmpfs') &&
      !(container.Mounts || []).some(
        (m) => m.Type === 'volume' || m.Type === 'bind',
      ),
  );
  check(
    Object.values(container.NetworkSettings.Ports || {}).every(
      (v) => v === null,
    ),
  );
  const url = new URL(rawUrl);
  check(
    url.protocol === 'postgresql:' &&
      url.hostname === owner.ip &&
      url.port === '5432' &&
      url.pathname === '/nest-practice-test' &&
      !url.search &&
      !url.hash,
  );
  check(decodeURIComponent(url.username) === owner.user && !!url.password);
  const env = Object.fromEntries(
    container.Config.Env.map((v) => [
      v.slice(0, v.indexOf('=')),
      v.slice(v.indexOf('=') + 1),
    ]),
  );
  check(
    env.POSTGRES_DB === 'nest-practice-test' &&
      env.POSTGRES_USER === owner.user &&
      env.POSTGRES_PASSWORD === decodeURIComponent(url.password),
  );
}

function verifyConstraints(before, after) {
  const removed = [
    'supplier_audit_supplier_fk',
    'supplier_receipt_supplier_fk',
  ];
  const changed = [
    'supplier_receipt_namespace_check',
    'supplier_receipt_http_check',
  ];
  check(
    before.filter((c) => removed.includes(c.name) && c.type === 'f').length ===
      2,
  );
  check(
    before.filter((c) => changed.includes(c.name) && c.type === 'c').length ===
      2,
  );
  assert.deepEqual(
    after.filter((c) => c.type === 'f'),
    before.filter((c) => c.type === 'f' && !removed.includes(c.name)),
  );
  assert.deepEqual(
    after.filter((c) => !changed.includes(c.name)),
    before.filter(
      (c) => !removed.includes(c.name) && !changed.includes(c.name),
    ),
  );
  for (const name of changed) {
    const c = after.find((v) => v.name === name);
    check(c?.type === 'c' && c.validated && c.definition.includes('DELETE'));
    if (name.endsWith('http_check'))
      check(
        c.definition.includes('204') &&
          c.definition.includes('responseBody') &&
          c.definition.includes('null'),
      );
  }
}

const IDENTITY_SQL =
  'SELECT current_database() AS database, current_user AS username, host(inet_server_addr()) AS ip';
const EMPTY_SCHEMA_SQL = `SELECT
  EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='public') AS public_exists,
  EXISTS (
    SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace
    UNION ALL SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace
    UNION ALL SELECT 1 FROM pg_type WHERE typnamespace='public'::regnamespace
    UNION ALL SELECT 1 FROM pg_constraint WHERE connamespace='public'::regnamespace
  ) AS public_nonempty,
  EXISTS (SELECT 1 FROM pg_class WHERE relname='_prisma_migrations') AS ledger_present`;

function validateIdentity(identity, owner) {
  check(
    identity.database === owner.database &&
      identity.username === owner.user &&
      identity.ip === owner.ip,
  );
}

function validateEmptySchema(row) {
  check(
    row.public_exists === true &&
      row.public_nonempty === false &&
      row.ledger_present === false,
  );
}

function validateResumeState(result) {
  const allowed = new Set([
    'canonical-root',
    'common-dir',
    'cached-image',
    'network-create',
    'container-create',
    'container-start',
    'container-inspect',
    'network-inspect',
    'readiness',
  ]);
  check(
    result.state === 'failed' &&
      ['readiness', 'identity'].includes(result.failedAt),
  );
  check(result.resourcesRetained === true && !result.resumeAttempt);
  check(
    !result.preservation && !result.constraints && !result.integrationStatuses,
  );
  check(Array.isArray(result.commands) && result.commands.length > 0);
  check(
    result.commands.every(
      (c) =>
        allowed.has(c.label) &&
        !c.spawnError &&
        !c.signal &&
        (c.status === 0 ||
          (c.label === 'readiness' && [1, 2].includes(c.status))),
    ),
  );
  for (const label of [
    'canonical-root',
    'common-dir',
    'network-create',
    'container-create',
    'container-start',
  ])
    check(
      result.commands.filter((c) => c.label === label && c.status === 0)
        .length === 1,
    );
}

// Metadata operations only; injectable filesystem keeps resume tests entirely offline.
function loadResume(argument, io = fs, uid = process.getuid()) {
  const directory = path.resolve(ROOT, argument);
  check(
    path.dirname(directory) === path.join(ROOT, '.tmp') &&
      /^delete-migration-proof\.[A-Za-z0-9]+$/.test(path.basename(directory)),
  );
  const privatePath = (file, isDirectory, privateMode = true) => {
    const stat = io.lstatSync(file);
    check(
      !stat.isSymbolicLink() &&
        stat.uid === uid &&
        (isDirectory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1),
    );
    check(io.realpathSync(file) === file);
    if (privateMode)
      check((stat.mode & 0o777) === (isDirectory ? 0o700 : 0o600));
  };
  privatePath(path.join(ROOT, '.tmp'), true, false);
  privatePath(directory, true);
  const names = [
    'ownership.json',
    'postgres.env',
    'results.json',
    'target.env',
  ];
  assert.deepEqual(io.readdirSync(directory).sort(), names);
  for (const name of names) privatePath(path.join(directory, name), false);
  const read = (name) => io.readFileSync(path.join(directory, name), 'utf8');
  let result, owner;
  try {
    result = JSON.parse(read('results.json'));
    owner = JSON.parse(read('ownership.json'));
  } catch {
    throw new Error('Invalid resume metadata');
  }
  validateResumeState(result);
  check(
    owner.root === ROOT &&
      /^[a-f0-9]{32}$/.test(owner.token) &&
      owner.name === `houndfe-delete-${owner.token}` &&
      owner.network === `${owner.name}-net` &&
      owner.user === `proof_${owner.token}` &&
      owner.database === 'nest-practice-test',
  );
  const target =
    /^DATABASE_URL=(postgresql:\/\/[^\r\n]+)\nHOUNDFE_TEST_DATABASE_URL_FROM_SHELL=1\n$/.exec(
      read('target.env'),
    );
  check(target);
  return { directory, owner, url: target[1], result };
}

function proofEnvironment(directory) {
  return {
    PATH: [
      path.join(ROOT, 'node_modules/.bin'),
      path.dirname(process.execPath),
      '/usr/bin',
      '/bin',
    ].join(':'),
    HOME: directory,
    TMPDIR: directory,
    DOCKER_CONFIG: directory,
    LANG: 'C.UTF-8',
    NODE_ENV: 'test',
    CI: '1',
    HOUNDFE_TEST_DATABASE_URL_FROM_SHELL: '1',
    npm_config_offline: 'true',
    // Defense in depth, not a replacement for installed-CLI invocation.
    COREPACK_ENABLE_NETWORK: '0',
    PRISMA_GENERATE_SKIP_AUTOINSTALL: 'true',
  };
}

async function main() {
  check(
    fs.realpathSync(process.cwd()) === ROOT && fs.realpathSync(ROOT) === ROOT,
  );
  check(fs.statSync(path.join(ROOT, '.git')).isFile()); // Registered isolated worktree only.
  for (const file of ['.env', '.env.test', 'prisma/.env'])
    check(!fs.existsSync(path.join(ROOT, file)));
  const args = process.argv.slice(2);
  check(args.length === 0 || (args.length === 2 && args[0] === '--resume'));
  const resume = args.length ? loadResume(args[1]) : null;
  const directory = resume
    ? resume.directory
    : fs.mkdtempSync(path.join(ROOT, '.tmp/delete-migration-proof.'));
  if (!resume) fs.chmodSync(directory, 0o700);
  const save = (name, data) =>
    fs.writeFileSync(
      path.join(directory, name),
      JSON.stringify(data, null, 2),
      { mode: 0o600 },
    );
  const result = resume
    ? { ...resume.result, state: 'resume-preflight', resumeAttempt: true }
    : { state: 'preflight', commands: [], resourcesRetained: true };
  if (resume) {
    // Exclusive durable marker prevents a second/parallel resume, even after a crash.
    fs.writeFileSync(
      path.join(directory, 'resume-attempt.json'),
      JSON.stringify({ priorFailure: resume.result.failedAt }),
      { mode: 0o600, flag: 'wx' },
    );
    fs.writeFileSync(
      path.join(directory, 'resume-prior-results.json'),
      JSON.stringify(resume.result, null, 2),
      { mode: 0o600, flag: 'wx' },
    );
    save('results.json', result);
  }
  const env = proofEnvironment(directory);
  // pg also consults ambient PG*/SSL variables in this process, not just children.
  process.env = { ...env };
  env.CHECKPOINT_DISABLE = '1';
  env.PRISMA_HIDE_UPDATE_MESSAGE = '1';
  const run = (label, command, args, extra = {}, allowFailure = false) => {
    const r = spawnSync(command, args, {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      timeout: 300000,
      maxBuffer: 32 * 1024 * 1024,
      ...extra,
    });
    result.commands.push({
      label,
      status: r.status,
      signal: r.signal,
      spawnError: r.error?.code || null,
      outputSha256: digest((r.stdout || '') + (r.stderr || '')),
    });
    save('results.json', result);
    if (label === 'migrate-deploy' || label.startsWith('integration-')) {
      let output = (r.stdout || '') + (r.stderr || '');
      if (env.DATABASE_URL) {
        let target;
        try {
          target = new URL(env.DATABASE_URL);
        } catch {
          throw new Error('Invalid private database target');
        }
        output = output.split(env.DATABASE_URL).join('[REDACTED DATABASE URL]');
        output = output
          .split(decodeURIComponent(target.password))
          .join('[REDACTED]');
      }
      output = output.replace(
        /postgres(?:ql)?:\/\/[^\s"']+/g,
        '[REDACTED DATABASE URL]',
      );
      fs.writeFileSync(
        path.join(directory, `${result.commands.length}-${label}.log`),
        output,
        { mode: 0o600, flag: 'wx' },
      );
    }
    if (!allowFailure) check(!r.error && r.status === 0);
    return r;
  };
  const docker = (label, args, extra, allowFailure) =>
    run(
      label,
      'docker',
      ['--host', 'unix:///var/run/docker.sock', ...args],
      extra,
      allowFailure,
    );
  let db;
  try {
    check(
      run('canonical-root', 'git', [
        'rev-parse',
        '--show-toplevel',
      ]).stdout.trim() === ROOT,
    );
    check(
      path.resolve(
        ROOT,
        run('common-dir', 'git', [
          'rev-parse',
          '--git-common-dir',
        ]).stdout.trim(),
      ) !== path.join(ROOT, '.git'),
    );
    check(require('prisma/package.json').version.startsWith('6.'));
    let owner = resume?.owner;
    let url = resume?.url;
    if (!resume) {
      const token = crypto.randomBytes(16).toString('hex');
      owner = {
        root: ROOT,
        token,
        name: `houndfe-delete-${token}`,
        network: `houndfe-delete-${token}-net`,
        user: `proof_${token}`,
        database: 'nest-practice-test',
      };
      save('ownership.json', owner);
      const password = crypto.randomBytes(32).toString('hex');
      const envFile = path.join(directory, 'postgres.env');
      fs.writeFileSync(
        envFile,
        `POSTGRES_USER=${owner.user}\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=${owner.database}\n`,
        { mode: 0o600 },
      );
      // No pulls, existing-resource adoption, recreation, deletion, or retry.
      owner.imageId = JSON.parse(
        docker('cached-image', ['image', 'inspect', 'postgres:17']).stdout,
      )[0].Id;
      save('ownership.json', owner);
      result.state = 'creating-network';
      save('results.json', result);
      owner.networkId = docker('network-create', [
        'network',
        'create',
        '--internal',
        '--label',
        `${LABEL}=${token}`,
        owner.network,
      ]).stdout.trim();
      save('ownership.json', owner);
      result.state = 'creating-container';
      save('results.json', result);
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
        '--env-file',
        envFile,
        'postgres:17',
      ]).stdout.trim();
      save('ownership.json', owner);
      docker('container-start', ['start', owner.containerId]);
      const created = JSON.parse(
        docker('container-inspect', ['inspect', owner.containerId]).stdout,
      )[0];
      owner.ip = created.NetworkSettings.Networks[owner.network]?.IPAddress;
      url = `postgresql://${owner.user}:${password}@${owner.ip}:5432/${owner.database}`;
    }
    const inspect = () => {
      const c = JSON.parse(
        docker('container-inspect', ['inspect', owner.containerId]).stdout,
      )[0];
      const n = JSON.parse(
        docker('network-inspect', ['network', 'inspect', owner.networkId])
          .stdout,
      )[0];
      return [c, n];
    };
    const guard = () => {
      const [container, network] = inspect();
      validateTarget(
        owner,
        container,
        network,
        url,
        fs.realpathSync(process.cwd()),
      );
    };
    guard();
    if (!resume) {
      save('ownership.json', owner);
      fs.writeFileSync(
        path.join(directory, 'target.env'),
        `DATABASE_URL=${url}\nHOUNDFE_TEST_DATABASE_URL_FROM_SHELL=1\n`,
        { mode: 0o600 },
      );
    }
    env.DATABASE_URL = url;
    process.env.DATABASE_URL = url;
    result.state = 'readiness';
    save('results.json', result);
    let ready = false;
    for (let i = 0; i < 30; i++) {
      const r = docker(
        'readiness',
        [
          'exec',
          owner.containerId,
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-U',
          owner.user,
          '-d',
          owner.database,
        ],
        {},
        true,
      );
      check(!r.error && [0, 1, 2].includes(r.status));
      if (r.status === 0) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    check(ready);
    guard();
    result.state = 'identity';
    save('results.json', result);
    const { Client } = require('pg');
    db = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    await db.connect();
    const identity = (await db.query(IDENTITY_SQL)).rows[0];
    validateIdentity(identity, owner);
    // No migration can follow a resume unless the catalog proves it untouched.
    result.state = 'empty-schema-check';
    save('results.json', result);
    const empty = (await db.query(EMPTY_SCHEMA_SQL)).rows[0];
    validateEmptySchema(empty);
    save('identity.json', identity);
    save('empty-schema.json', empty);
    const schemaDir = path.join(directory, 'prisma');
    fs.mkdirSync(path.join(schemaDir, 'migrations'), {
      recursive: true,
      mode: 0o700,
    });
    fs.copyFileSync(
      path.join(ROOT, 'prisma/schema.prisma'),
      path.join(schemaDir, 'schema.prisma'),
    );
    const files = run('baseline-tree', 'git', [
      'ls-tree',
      '-r',
      '--name-only',
      'HEAD',
      '--',
      'prisma/migrations',
    ])
      .stdout.trim()
      .split('\n');
    const baseline = files.filter(
      (f) => !FORWARD.some((m) => f.includes(`/${m}/`)),
    );
    const rootMigrations = fs
      .readdirSync(path.join(ROOT, 'prisma/migrations'))
      .filter((f) => f !== 'migration_lock.toml')
      .sort();
    assert.deepEqual(
      rootMigrations,
      [
        ...new Set(
          baseline
            .filter((f) => f.endsWith('/migration.sql'))
            .map((f) => f.split('/')[2]),
        ),
        ...FORWARD,
      ].sort(),
    );
    check(
      baseline.includes('prisma/migrations/migration_lock.toml') &&
        baseline.includes(
          'prisma/migrations/20261102090000_procurement_suppliers/migration.sql',
        ),
    );
    const hashes = {};
    for (const file of baseline) {
      check(
        /^prisma\/migrations\/(migration_lock\.toml|[0-9a-z_]+\/migration\.sql)$/.test(
          file,
        ),
      );
      const content = run('baseline-read', 'git', [
        'show',
        `HEAD:${file}`,
      ]).stdout;
      const dest = path.join(schemaDir, path.relative('prisma', file));
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.writeFileSync(dest, content, { mode: 0o600 });
      hashes[file] = digest(content);
      // Jest globalSetup deploys the root tree: it must be the same baseline.
      check(digest(fs.readFileSync(path.join(ROOT, file))) === hashes[file]);
    }
    const deploy = () => {
      guard();
      run('migrate-deploy', process.execPath, [
        require.resolve('prisma/build/index.js'),
        'migrate',
        'deploy',
        '--schema',
        path.join(schemaDir, 'schema.prisma'),
      ]);
    };
    result.state = 'baseline';
    save('results.json', result);
    deploy();
    const ledger = async () =>
      (
        await db.query(
          'SELECT migration_name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back FROM "_prisma_migrations" ORDER BY migration_name',
        )
      ).rows;
    const baselineLedger = await ledger();
    check(
      baselineLedger.length ===
        baseline.filter((f) => f.endsWith('/migration.sql')).length &&
        baselineLedger.every(
          (r) =>
            r.finished &&
            !r.rolled_back &&
            r.checksum ===
              hashes[`prisma/migrations/${r.migration_name}/migration.sql`],
        ),
    );
    result.state = 'seeding';
    save('results.json', result);
    // Explicit old-schema SQL avoids a new generated-client dependency.
    await db.query(`INSERT INTO tenants (id,name,slug,"updatedAt") VALUES ('delete-proof','Delete proof','delete-proof',TIMESTAMP '2020-01-01');
      INSERT INTO procurement_suppliers (id,"tenantId","displayName","termsText",status,version,"createdAt","updatedAt") VALUES
      ('proof-active','delete-proof','Original 😀',NULL,'ACTIVE',2,TIMESTAMP '2020-01-01',TIMESTAMP '2020-02-01'),
      ('proof-archived','delete-proof','Archived','Historical terms','ARCHIVED',1,TIMESTAMP '2020-01-01',TIMESTAMP '2020-02-01');
      INSERT INTO procurement_supplier_audits (id,"tenantId","supplierId","actorId",operation,"supplierVersion",snapshot)
      SELECT 'audit-' || id,'delete-proof',id,'historical-actor','CREATE',1,jsonb_build_object('displayName','Original 😀','termsText',NULL,'version',1) FROM procurement_suppliers;
      INSERT INTO procurement_supplier_audits (id,"tenantId","supplierId","actorId",operation,"supplierVersion",snapshot)
      VALUES ('audit-update','delete-proof','proof-active','historical-actor','UPDATE',2,'{"displayName":"Original 😀","version":2}');
      INSERT INTO procurement_supplier_receipts ("tenantId","actorId",operation,target,"idempotencyKey","supplierId","requestHash","statusCode","responseBody")
      SELECT 'delete-proof','historical-actor',operation,CASE WHEN operation='CREATE' THEN 'collection' ELSE "supplierId" END,' key-' || id || ' ',"supplierId",repeat('a',64),CASE WHEN operation='CREATE' THEN 201 ELSE 200 END,snapshot FROM procurement_supplier_audits;`);
    const snapshot = async () =>
      Object.fromEntries(
        await Promise.all(
          TABLES.map(async (t) => [
            t,
            (
              await db.query(
                `SELECT to_jsonb(t)::text AS record FROM "${t}" t ORDER BY to_jsonb(t)::text`,
              )
            ).rows,
          ]),
        ),
      );
    const constraints = async () =>
      (
        await db.query(
          `SELECT c.conname AS name,c.contype AS type,c.convalidated AS validated,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' ORDER BY c.conrelid::regclass::text,c.conname`,
        )
      ).rows;
    const before = await snapshot(),
      beforeConstraints = await constraints();
    save('historical-before.json', before);
    save('constraints-before.json', beforeConstraints);
    for (const migration of FORWARD) {
      const dest = path.join(schemaDir, 'migrations', migration);
      fs.mkdirSync(dest, { mode: 0o700 });
      const content = fs.readFileSync(
        path.join(ROOT, 'prisma/migrations', migration, 'migration.sql'),
      );
      fs.writeFileSync(path.join(dest, 'migration.sql'), content, {
        mode: 0o600,
      });
      hashes[migration] = digest(content);
    }
    result.state = 'forward';
    save('results.json', result);
    deploy();
    const after = await snapshot(),
      afterConstraints = await constraints(),
      finalLedger = await ledger();
    save('historical-after.json', after);
    save('constraints-after.json', afterConstraints);
    save('ledger.json', finalLedger);
    save('migration-hashes.json', hashes);
    assert.deepEqual(after, before);
    verifyConstraints(beforeConstraints, afterConstraints);
    assert.deepEqual(
      finalLedger.filter((r) => !FORWARD.includes(r.migration_name)),
      baselineLedger,
    );
    check(
      finalLedger.length === baselineLedger.length + 2 &&
        finalLedger
          .filter((r) => FORWARD.includes(r.migration_name))
          .every(
            (r) =>
              r.finished &&
              !r.rolled_back &&
              r.checksum === hashes[r.migration_name],
          ),
    );
    check(
      (
        await db.query(
          `SELECT enumlabel FROM pg_enum WHERE enumtypid='"ProcurementSupplierOperation"'::regtype ORDER BY enumsortorder`,
        )
      ).rows
        .map((r) => r.enumlabel)
        .join(',') === 'CREATE,UPDATE,DELETE',
    );
    result.preservation = true;
    result.constraints = true;
    result.state = 'integration';
    save('results.json', result);
    await db.end();
    db = null;
    const statuses = [];
    for (const spec of ['storage', 'commands', 'queries']) {
      guard();
      // These helpers load .env.test preferentially; never mask that guard.
      for (const file of ['.env', '.env.test', 'prisma/.env'])
        check(!fs.existsSync(path.join(ROOT, file)));
      statuses.push(
        run(
          `integration-${spec}`,
          process.execPath,
          [
            require.resolve('jest/bin/jest'),
            '--config',
            'jest.integration.config.js',
            '--runInBand',
            '--no-cache',
            '--runTestsByPath',
            `src/procurement/suppliers/supplier-${spec}.integration.spec.ts`,
          ],
          {},
          true,
        ).status,
      );
    }
    result.integrationStatuses = statuses;
    check(statuses.every((s) => s === 0));
    result.state = 'passed';
    save('results.json', result);
    console.log(`Proof retained: ${path.relative(ROOT, directory)}`);
  } catch {
    result.failedAt = result.state;
    result.state = 'failed';
    save('results.json', result);
    console.error(
      `Proof failed; sanitized state retained: ${path.relative(ROOT, directory)}`,
    );
    process.exitCode = 1;
  } finally {
    if (db) await db.end().catch(() => {});
  }
}
module.exports = {
  proofEnvironment,
  validateTarget,
  verifyConstraints,
  validateIdentity,
  validateEmptySchema,
  validateResumeState,
  loadResume,
  IDENTITY_SQL,
  ROOT,
  LABEL,
};
if (require.main === module)
  main().catch(() => {
    console.error('Preflight rejected');
    process.exitCode = 1;
  });
