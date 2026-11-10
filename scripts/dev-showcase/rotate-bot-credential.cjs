// Dev only: rotates the chatbot service credential of one sucursal. A new
// credential (same scopes, rate limit and per-class rate limits) replaces every active one with the
// given name; the old ones are revoked in the same transaction. The raw token
// is written to a 0600 file under the gitignored `.tmp/` and never printed.
//
//   node scripts/dev-showcase/rotate-bot-credential.cjs --name "<credential>"           # dry run
//   node scripts/dev-showcase/rotate-bot-credential.cjs --name "<credential>" --apply
//
// Options: --tenant <slug> (default centro), --out <file> (default
// .tmp/chatbot-service-token). Same local-database guard as the showcase.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_OUT = '.tmp/chatbot-service-token';

/** `svc_` + 32 random bytes; the guard requires the prefix. */
function newToken(random = crypto.randomBytes) {
  return `svc_${random(32).toString('base64url')}`;
}

/** What ServiceCredential.hashedKey stores (ServiceAuthGuard hashes the same way). */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function parseArgs(argv) {
  const args = { tenant: 'centro', out: DEFAULT_OUT, apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--apply') args.apply = true;
    else if (['--name', '--tenant', '--out'].includes(flag)) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${flag} needs a value`);
      }
      args[flag.slice(2)] = value;
      i += 1;
    } else throw new Error(`unknown option ${flag}`);
  }
  if (!args.name) throw new Error('--name "<credential name>" is required');
  return args;
}

/**
 * What the replacement keeps from the credentials it replaces: every scope,
 * the first credential's `rateLimit`, and the per-class `rateLimits` (R2; the
 * first credential wins a class set on several). Null when none was set.
 */
function carriedOver(rows) {
  const rateLimits = Object.assign(
    {},
    ...rows.map((row) => row.rateLimits ?? {}).reverse(),
  );
  return {
    scopes: [...new Set(rows.flatMap((row) => row.scopes))].sort(),
    rateLimit: rows[0].rateLimit,
    rateLimits: Object.keys(rateLimits).length > 0 ? rateLimits : null,
  };
}

/** Name of the replacement: the base name plus the rotation date. */
function rotatedName(name, now) {
  const base = name.replace(/ \(rotada \d{4}-\d{2}-\d{2}\)$/, '');
  return `${base} (rotada ${now.toISOString().slice(0, 10)})`;
}

/** Writes the token readable only by the owner, replacing an older file. */
function writeSecret(file, token) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { loadEnv, assertSafeTarget } = require('./seed.cjs');
  loadEnv();
  assertSafeTarget();
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { slug: args.tenant },
    });
    if (!tenant) throw new Error(`tenant ${args.tenant} not found`);
    const current = await prisma.serviceCredential.findMany({
      where: {
        tenantId: tenant.id,
        name: args.name,
        isActive: true,
        revokedAt: null,
      },
      select: { id: true, scopes: true, rateLimit: true, rateLimits: true },
    });
    if (current.length === 0) {
      throw new Error(`no active credential "${args.name}" in ${tenant.name}`);
    }
    const { scopes, rateLimit, rateLimits } = carriedOver(current);
    const now = new Date();
    const name = rotatedName(args.name, now);
    const plan = {
      tenant: tenant.name,
      revoke: current.map((row) => row.id),
      create: { name, scopes, rateLimit, rateLimits },
      tokenFile: args.out,
    };
    if (!args.apply) {
      console.log(JSON.stringify({ dryRun: true, ...plan }, null, 2));
      return;
    }
    const token = newToken();
    // Write the token before revoking: if the file cannot be written, the old
    // credential stays active; if the transaction fails, the file is removed.
    const tokenFile = path.resolve(ROOT, args.out);
    writeSecret(tokenFile, token);
    const created = await prisma
      .$transaction(async (tx) => {
        await tx.serviceCredential.updateMany({
          where: { id: { in: plan.revoke } },
          data: { isActive: false, revokedAt: now },
        });
        return tx.serviceCredential.create({
          data: {
            tenantId: tenant.id,
            name,
            hashedKey: hashToken(token),
            scopes,
            rateLimit,
            // Json null needs an explicit marker; leave the column unset.
            ...(rateLimits ? { rateLimits } : {}),
          },
          select: { id: true },
        });
      })
      .catch((error) => {
        fs.rmSync(tokenFile, { force: true });
        throw error;
      });
    console.log(JSON.stringify({ ...plan, createdId: created.id }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  newToken,
  hashToken,
  parseArgs,
  rotatedName,
  writeSecret,
  carriedOver,
};
