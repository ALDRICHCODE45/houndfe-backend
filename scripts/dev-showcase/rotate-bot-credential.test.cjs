// Offline: `node --test scripts/dev-showcase/rotate-bot-credential.test.cjs`
// (no database; the file check writes only to a fresh OS temp directory).
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  newToken,
  hashToken,
  parseArgs,
  rotatedName,
  writeSecret,
  carriedOver,
} = require('./rotate-bot-credential.cjs');

test('tokens carry the svc_ prefix and hash to 64 hex chars', () => {
  const token = newToken();
  assert.match(token, /^svc_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(newToken(), token);
  assert.match(hashToken(token), /^[0-9a-f]{64}$/);
  // Fixed vector: sha256("svc_x").
  assert.equal(
    hashToken('svc_x'),
    require('node:crypto').createHash('sha256').update('svc_x').digest('hex'),
  );
});

test('parseArgs needs a name and defaults to Centro and .tmp/', () => {
  assert.throws(() => parseArgs([]), /--name/);
  assert.throws(() => parseArgs(['--name']), /needs a value/);
  assert.throws(() => parseArgs(['--name', 'a', '--token', 'x']), /unknown/);
  assert.deepEqual(parseArgs(['--name', 'bot']), {
    name: 'bot',
    tenant: 'centro',
    out: '.tmp/chatbot-service-token',
    apply: false,
  });
  assert.equal(parseArgs(['--name', 'bot', '--apply']).apply, true);
});

test('rotatedName stamps the date once', () => {
  const now = new Date('2026-11-06T18:00:00Z');
  assert.equal(rotatedName('bot', now), 'bot (rotada 2026-11-06)');
  assert.equal(
    rotatedName('bot (rotada 2026-10-01)', now),
    'bot (rotada 2026-11-06)',
  );
});

test('writeSecret leaves a 0600 file even when one existed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-bot-'));
  const file = path.join(dir, 'nested', 'token');
  writeSecret(file, 'svc_old');
  fs.chmodSync(file, 0o644);
  writeSecret(file, 'svc_new');
  assert.equal(fs.readFileSync(file, 'utf8'), 'svc_new\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true });
});

test('carriedOver keeps scopes, rateLimit and the per-class rateLimits', () => {
  assert.deepEqual(
    carriedOver([
      {
        scopes: ['requests:create', 'catalog:read'],
        rateLimit: 90,
        rateLimits: { write: 600, humanDecisions: 120 },
      },
      {
        scopes: ['catalog:read', 'feed:read'],
        rateLimit: 60,
        rateLimits: { write: 10, feed: 30 },
      },
    ]),
    {
      scopes: ['catalog:read', 'feed:read', 'requests:create'],
      rateLimit: 90,
      rateLimits: { write: 600, humanDecisions: 120, feed: 30 },
    },
  );
  assert.equal(
    carriedOver([{ scopes: ['a'], rateLimit: 60, rateLimits: null }])
      .rateLimits,
    null,
  );
});
