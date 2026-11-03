'use strict';
// Parent-only bridge: private proof metadata -> fresh FE RUN, no shell env-file sourcing.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const {
  ROOT,
  proofEnvironment,
  validateTarget,
} = require('../supplier-runtime/verify-delete-migration.cjs');
const {
  validatePrivatePath,
  validateTarget: validateManifest,
} = require('./host.cjs');
function validateProofPath(directory) {
  assert.equal(path.dirname(directory), path.join(ROOT, '.tmp'));
  assert(/^po-migration-proof\.[A-Za-z0-9]+$/.test(path.basename(directory)));
}
function launch() {
  assert([3, 4].includes(process.argv.length));
  assert.equal(fs.realpathSync(process.cwd()), ROOT);
  for (const file of ['.env', '.env.test', 'prisma/.env'])
    assert(!fs.existsSync(path.join(ROOT, file)));
  const proof = path.resolve(process.argv[2]);
  validateProofPath(proof);
  const privatePath = (file, mode) =>
    validatePrivatePath(
      file,
      fs.realpathSync(file),
      fs.lstatSync(file),
      process.getuid(),
      mode,
    );
  privatePath(proof, 0o700);
  const read = (name) => {
    const file = path.join(proof, name);
    privatePath(file, 0o600);
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error('Invalid private proof');
    }
  };
  const result = read('results.json');
  assert.equal(result.state, 'passed');
  assert.equal(result.resourcesRetained, true);
  const owner = read('ownership.json');
  const { url } = read('target.json');
  const identity = read('target-identity.json');
  validateManifest(identity, url);
  assert.deepEqual(identity, {
    database: owner.database,
    username: owner.user,
    ip: owner.ip,
  });
  const env = proofEnvironment(proof);
  const inspect = (args) => {
    const response = spawnSync(
      'docker',
      ['--host', 'unix:///var/run/docker.sock', ...args],
      { env, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
    );
    assert(!response.error && !response.signal && response.status === 0);
    try {
      return JSON.parse(response.stdout)[0];
    } catch {
      throw new Error('Invalid ownership observation');
    }
  };
  validateTarget(
    owner,
    inspect(['inspect', owner.containerId]),
    inspect(['network', 'inspect', owner.networkId]),
    url,
    ROOT,
  );
  const origin = process.argv[3] || 'http://127.0.0.1:43179';
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error('Invalid FE origin');
  }
  assert(
    ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin,
  );
  const run = fs.mkdtempSync(path.join(ROOT, '.tmp/po-runtime.'));
  fs.chmodSync(run, 0o700);
  fs.writeFileSync(
    path.join(run, 'target-identity.json'),
    JSON.stringify(identity, null, 2),
    { mode: 0o600, flag: 'wx' },
  );
  console.log(`Fresh FE RUN: ${path.relative(ROOT, run)}`);
  const child = spawnSync(
    process.execPath,
    [path.join(__dirname, 'host.cjs'), run, origin],
    {
      cwd: ROOT,
      env: {
        ...proofEnvironment(run),
        NODE_ENV: 'development',
        DATABASE_URL: url,
      },
      stdio: 'inherit',
    },
  );
  assert(!child.error && !child.signal && child.status === 0);
}
module.exports = { validateProofPath };
if (require.main === module) {
  try {
    launch();
  } catch {
    console.error('PO launcher rejected or host failed; resources retained');
    process.exitCode = 1;
  }
}
