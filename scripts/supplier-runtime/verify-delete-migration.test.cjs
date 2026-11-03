'use strict';
// Offline only: importing the implementation never spawns processes or connects.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
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
} = require('./verify-delete-migration.cjs');

test('proof children receive offline defenses without inheriting ambient env', () => {
  const env = proofEnvironment(`${ROOT}/.tmp/synthetic-proof`);
  assert.equal(env.COREPACK_ENABLE_NETWORK, '0');
  assert.equal(env.PRISMA_GENERATE_SKIP_AUTOINSTALL, 'true');
  assert.equal(env.npm_config_offline, 'true');
  assert.equal(env.HOME, `${ROOT}/.tmp/synthetic-proof`);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
});

function fixture() {
  const owner = {
    root: ROOT,
    containerId: 'a'.repeat(64),
    networkId: 'b'.repeat(64),
    name: 'new-proof',
    network: 'new-network',
    token: 'owned',
    user: 'new-user',
    ip: '172.29.0.2',
    imageId: `sha256:${'d'.repeat(64)}`,
  };
  const container = {
    Id: owner.containerId,
    Image: owner.imageId,
    Name: '/new-proof',
    State: { Running: true },
    Config: {
      Image: 'postgres:17',
      Labels: { [LABEL]: 'owned' },
      Env: [
        'POSTGRES_DB=nest-practice-test',
        'POSTGRES_USER=new-user',
        'POSTGRES_PASSWORD=synthetic-only',
      ],
    },
    HostConfig: {
      NetworkMode: owner.network,
      ReadonlyRootfs: true,
      Tmpfs: { '/var/lib/postgresql/data': 'rw', '/var/run/postgresql': 'rw' },
    },
    Mounts: [{ Type: 'tmpfs' }],
    NetworkSettings: {
      Networks: {
        [owner.network]: { NetworkID: owner.networkId, IPAddress: owner.ip },
      },
      Ports: { '5432/tcp': null },
    },
  };
  const network = {
    Id: owner.networkId,
    Name: owner.network,
    Internal: true,
    Labels: { [LABEL]: 'owned' },
    Containers: { [owner.containerId]: { IPv4Address: `${owner.ip}/16` } },
  };
  return {
    owner,
    container,
    network,
    url: 'postgresql://new-user:synthetic-only@172.29.0.2:5432/nest-practice-test',
    cwd: ROOT,
  };
}
const validate = (f) =>
  validateTarget(f.owner, f.container, f.network, f.url, f.cwd);
test('fresh private postgres17 target accepted without executing anything', () =>
  validate(fixture()));
const failures = {
  cwd: (f) => {
    f.cwd = '/wrong';
  },
  root: (f) => {
    f.owner.root = '/wrong';
  },
  containerId: (f) => {
    f.container.Id = 'c'.repeat(64);
  },
  containerName: (f) => {
    f.container.Name = '/original';
  },
  stopped: (f) => {
    f.container.State.Running = false;
  },
  image: (f) => {
    f.container.Config.Image = 'postgres:latest';
  },
  imageId: (f) => {
    f.container.Image = `sha256:${'e'.repeat(64)}`;
  },
  ownerLabel: (f) => {
    f.container.Config.Labels[LABEL] = 'foreign';
  },
  networkId: (f) => {
    f.network.Id = 'c'.repeat(64);
  },
  networkName: (f) => {
    f.network.Name = 'foreign';
  },
  networkOwner: (f) => {
    f.network.Labels[LABEL] = 'foreign';
  },
  externalNetwork: (f) => {
    f.network.Internal = false;
  },
  sharedNetwork: (f) => {
    f.network.Containers.other = { IPv4Address: '172.29.0.3/16' };
  },
  secondAttachment: (f) => {
    f.container.NetworkSettings.Networks.bridge = {};
  },
  attachedNetworkId: (f) => {
    f.container.NetworkSettings.Networks[f.owner.network].NetworkID =
      'c'.repeat(64);
  },
  ipMismatch: (f) => {
    f.owner.ip = '172.29.0.9';
  },
  networkIpMismatch: (f) => {
    f.network.Containers[f.owner.containerId].IPv4Address = '172.29.0.8/16';
  },
  privileged: (f) => {
    f.container.HostConfig.Privileged = true;
  },
  publishAll: (f) => {
    f.container.HostConfig.PublishAllPorts = true;
  },
  binding: (f) => {
    f.container.HostConfig.PortBindings = { '5432/tcp': [] };
  },
  published: (f) => {
    f.container.NetworkSettings.Ports['5432/tcp'] = [{ HostPort: '5433' }];
  },
  bind: (f) => {
    f.container.HostConfig.Binds = ['/host:/data'];
  },
  volume: (f) => {
    f.container.Mounts.push({ Type: 'volume' });
  },
  missingTmpfs: (f) => {
    delete f.container.HostConfig.Tmpfs['/var/lib/postgresql/data'];
  },
  writableRoot: (f) => {
    f.container.HostConfig.ReadonlyRootfs = false;
  },
  networkMode: (f) => {
    f.container.HostConfig.NetworkMode = 'host';
  },
  databaseEnv: (f) => {
    f.container.Config.Env[0] = 'POSTGRES_DB=original';
  },
  userEnv: (f) => {
    f.container.Config.Env[1] = 'POSTGRES_USER=original';
  },
  passwordEnv: (f) => {
    f.container.Config.Env[2] = 'POSTGRES_PASSWORD=other';
  },
};
for (const [name, corrupt] of Object.entries(failures)) {
  test(`rejects ${name} before mutation`, () => {
    const f = fixture();
    corrupt(f);
    let mutations = 0;
    assert.throws(() => {
      validate(f);
      mutations++;
    });
    assert.equal(mutations, 0);
  });
}
for (const url of [
  'postgresql://new-user:synthetic-only@127.0.0.1:5432/nest-practice-test',
  'postgresql://new-user:synthetic-only@172.29.0.2:3000/nest-practice-test',
  'postgresql://new-user:synthetic-only@172.29.0.2:5432/unique-test',
  'postgresql://wrong:synthetic-only@172.29.0.2:5432/nest-practice-test',
  'postgresql://new-user:wrong@172.29.0.2:5432/nest-practice-test',
  'postgresql://new-user:synthetic-only@172.29.0.2:5432/nest-practice-test?host=original',
  'postgres://new-user:synthetic-only@172.29.0.2:5432/nest-practice-test',
])
  test('rejects altered URL without echoing credentials', () => {
    const f = fixture();
    f.url = url;
    assert.throws(
      () => validate(f),
      (e) => !e.message.includes('synthetic-only'),
    );
  });
function constraintFixture() {
  const row = (name, type, definition = 'unchanged') => ({
    name,
    type,
    definition,
    validated: true,
  });
  const unchanged = [
    row('supplier_tenant_fk', 'f'),
    row('supplier_audit_tenant_fk', 'f'),
    row('supplier_receipt_tenant_fk', 'f'),
    row('supplier_version_check', 'c'),
    row('supplier_audit_version_key', 'u'),
  ];
  return {
    before: [
      ...unchanged,
      row('supplier_audit_supplier_fk', 'f'),
      row('supplier_receipt_supplier_fk', 'f'),
      row('supplier_receipt_namespace_check', 'c'),
      row('supplier_receipt_http_check', 'c'),
    ],
    after: [
      ...unchanged,
      row('supplier_receipt_namespace_check', 'c', 'DELETE'),
      row('supplier_receipt_http_check', 'c', 'DELETE 204 responseBody null'),
    ],
  };
}
test('accepts only two removed FKs and the two authorized revised checks', () => {
  const f = constraintFixture();
  verifyConstraints(f.before, f.after);
});
for (const name of [
  'supplier_tenant_fk',
  'supplier_audit_tenant_fk',
  'supplier_receipt_tenant_fk',
  'supplier_version_check',
  'supplier_audit_version_key',
]) {
  test(`rejects missing retained constraint ${name}`, () => {
    const f = constraintFixture();
    assert.throws(() =>
      verifyConstraints(
        f.before,
        f.after.filter((r) => r.name !== name),
      ),
    );
  });
}
test('host(inet_server_addr()) fixes CIDR formatting without relaxing IP equality', () => {
  const f = fixture();
  f.owner.database = 'nest-practice-test';
  const cidr = `${f.owner.ip}/32`;
  const identity = {
    database: f.owner.database,
    username: f.owner.user,
    ip: cidr,
  };
  assert.throws(() => validateIdentity(identity, f.owner));
  assert.match(IDENTITY_SQL, /host\(inet_server_addr\(\)\) AS ip/);
  // Offline query adapter models PostgreSQL host(inet) versus inet::text.
  const query = (sql) => ({
    ...identity,
    ip: sql.includes('host(inet_server_addr())') ? cidr.split('/')[0] : cidr,
  });
  validateIdentity(query(IDENTITY_SQL), f.owner);
  assert.throws(() =>
    validateIdentity({ ...identity, ip: '172.29.0.9' }, f.owner),
  );
});

function resumeFixture() {
  const argument = '.tmp/delete-migration-proof.SyZbUU';
  const directory = `${ROOT}/${argument}`;
  const token = '1'.repeat(32);
  const owner = {
    ...fixture().owner,
    token,
    name: `houndfe-delete-${token}`,
    network: `houndfe-delete-${token}-net`,
    user: `proof_${token}`,
    database: 'nest-practice-test',
  };
  const result = {
    state: 'failed',
    failedAt: 'readiness',
    resourcesRetained: true,
    commands: [
      'canonical-root',
      'common-dir',
      'cached-image',
      'network-create',
      'container-create',
      'container-start',
      'container-inspect',
      'network-inspect',
      'readiness',
    ].map((label) => ({ label, status: 0, signal: null, spawnError: null })),
  };
  const contents = {
    'ownership.json': JSON.stringify(owner),
    'results.json': JSON.stringify(result),
    'target.env': `DATABASE_URL=postgresql://${owner.user}:synthetic-only@${owner.ip}:5432/nest-practice-test\nHOUNDFE_TEST_DATABASE_URL_FROM_SHELL=1\n`,
    'postgres.env': 'must never be read',
  };
  const reads = [],
    metadata = {};
  for (const file of [
    `${ROOT}/.tmp`,
    directory,
    ...Object.keys(contents).map((n) => `${directory}/${n}`),
  ]) {
    const isDirectory = file === directory || file === `${ROOT}/.tmp`;
    metadata[file] = {
      uid: 123,
      mode: isDirectory ? 0o700 : 0o600,
      nlink: 1,
      isSymbolicLink: () => false,
      isDirectory: () => isDirectory,
      isFile: () => !isDirectory,
    };
  }
  const io = {
    lstatSync: (file) => metadata[file],
    realpathSync: (file) => file,
    readdirSync: () => Object.keys(contents),
    readFileSync: (file) => {
      const name = file.split('/').at(-1);
      reads.push(name);
      return contents[name];
    },
  };
  return { argument, directory, owner, result, contents, reads, metadata, io };
}

test('loads only private credentials/metadata for an untouched failed checkpoint', () => {
  const f = resumeFixture();
  const loaded = loadResume(f.argument, f.io, 123);
  assert.deepEqual(loaded.owner, f.owner);
  assert.equal(loaded.directory, f.directory);
  assert.deepEqual(f.reads, ['results.json', 'ownership.json', 'target.env']);
  const target = fixture();
  target.owner = f.owner;
  target.container.Name = `/${f.owner.name}`;
  target.container.Config.Labels[LABEL] = f.owner.token;
  target.container.Config.Env[1] = `POSTGRES_USER=${f.owner.user}`;
  target.container.HostConfig.NetworkMode = f.owner.network;
  target.container.NetworkSettings.Networks = {
    [f.owner.network]: { NetworkID: f.owner.networkId, IPAddress: f.owner.ip },
  };
  target.network.Name = f.owner.network;
  target.network.Labels[LABEL] = f.owner.token;
  validateTarget(f.owner, target.container, target.network, loaded.url, ROOT);
});
for (const failure of [
  'baseline',
  'seeding',
  'forward',
  'integration',
  'empty-schema-check',
  'resume-preflight',
]) {
  test(`refuses resume after ${failure}`, () => {
    const f = resumeFixture();
    f.result.failedAt = failure;
    assert.throws(() => validateResumeState(f.result));
  });
}
for (const corrupt of [
  (r) => {
    r.state = 'passed';
  },
  (r) => {
    r.resumeAttempt = true;
  },
  (r) => {
    r.preservation = true;
  },
  (r) => {
    r.integrationStatuses = [1];
  },
  (r) => {
    r.commands.push({ label: 'migrate-deploy', status: 1 });
  },
  (r) => {
    r.commands.push({ label: 'baseline-tree', status: 0 });
  },
  (r) => {
    r.commands[4].status = null;
  },
  (r) => {
    r.commands[4].signal = 'SIGTERM';
  },
  (r) => {
    r.commands[4].spawnError = 'ETIMEDOUT';
  },
  (r) => {
    r.commands = [];
  },
])
  test('rejects ambiguous, progressed, or already resumed state before credentials', () => {
    const f = resumeFixture();
    corrupt(f.result);
    f.contents['results.json'] = JSON.stringify(f.result);
    assert.throws(() => loadResume(f.argument, f.io, 123));
    assert.ok(!f.reads.includes('target.env'));
  });
test('identity-only failure is eligible, but nonempty public schema or any ledger is not', () => {
  const f = resumeFixture();
  f.result.failedAt = 'identity';
  validateResumeState(f.result);
  validateEmptySchema({
    public_exists: true,
    public_nonempty: false,
    ledger_present: false,
  });
  for (const row of [
    { public_exists: false, public_nonempty: false, ledger_present: false },
    { public_exists: true, public_nonempty: true, ledger_present: false },
    { public_exists: true, public_nonempty: false, ledger_present: true },
    {},
  ])
    assert.throws(() => validateEmptySchema(row));
});
for (const name of [
  'identity.json',
  'prisma',
  'resume-attempt.json',
  'ledger.json',
]) {
  test(`refuses progressed or concurrent artifact ${name}`, () => {
    const f = resumeFixture();
    f.contents[name] = 'exists';
    assert.throws(() => loadResume(f.argument, f.io, 123));
    assert.deepEqual(f.reads, []);
  });
}
for (const location of [
  'directory',
  'parent',
  'ownership.json',
  'target.env',
  'results.json',
  'postgres.env',
]) {
  const corruptions =
    location === 'parent'
      ? ['symlink', 'wrong-owner']
      : ['symlink', 'wrong-owner', 'permissions'];
  for (const corruption of corruptions) {
    test(`rejects ${corruption} at ${location} before reading any credentials`, () => {
      const f = resumeFixture();
      const file =
        location === 'directory'
          ? f.directory
          : location === 'parent'
            ? `${ROOT}/.tmp`
            : `${f.directory}/${location}`;
      const stat = f.metadata[file];
      if (corruption === 'symlink') stat.isSymbolicLink = () => true;
      if (corruption === 'wrong-owner') stat.uid = 999;
      if (corruption === 'permissions') stat.mode |= 0o044;
      assert.throws(() => loadResume(f.argument, f.io, 123));
      assert.deepEqual(f.reads, []);
    });
  }
}
test('rejects realpath escape, hardlinked credentials, invalid target format, and foreign root', () => {
  const f = resumeFixture();
  f.io.realpathSync = () => '/other';
  assert.throws(() => loadResume(f.argument, f.io, 123));
  const linked = resumeFixture();
  linked.metadata[`${linked.directory}/target.env`].nlink = 2;
  assert.throws(() => loadResume(linked.argument, linked.io, 123));
  const malformed = resumeFixture();
  malformed.contents['target.env'] += 'PGHOST=original\n';
  assert.throws(() => loadResume(malformed.argument, malformed.io, 123));
  const foreign = resumeFixture();
  foreign.owner.root = '/other';
  foreign.contents['ownership.json'] = JSON.stringify(foreign.owner);
  assert.throws(() => loadResume(foreign.argument, foreign.io, 123));
  for (const argument of [
    '/tmp/delete-migration-proof.SyZbUU',
    '.tmp/other',
    '.tmp/delete-migration-proof.SyZbUU/subdir',
  ])
    assert.throws(() => loadResume(argument, resumeFixture().io, 123));
});

test('rejects invalidated or incomplete replacement checks', () => {
  for (const change of [
    (r) => {
      r.validated = false;
    },
    (r) => {
      r.definition = 'DELETE';
    },
  ]) {
    const f = constraintFixture();
    change(f.after.at(-1));
    assert.throws(() => verifyConstraints(f.before, f.after));
  }
});
