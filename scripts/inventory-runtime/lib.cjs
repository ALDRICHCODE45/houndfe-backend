'use strict';
// O1 inventory-journal runtime helpers: env loading, a tiny fetch client and login.
// Never prints credentials, tokens or the database URL. Imports are inert.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const TENANT_SLUG = 'centro';
const TENANT_NAME = 'Sucursal Centro';
// Natural login keys of the dev seed (prisma/seed.ts). Passwords come from the
// environment only: INVENTORY_DEV_PASSWORD / INVENTORY_NOPERM_PASSWORD.
const DEV_EMAIL = process.env.INVENTORY_DEV_EMAIL || 'manager@houndfe.com';
const NOPERM_EMAIL =
  process.env.INVENTORY_NOPERM_EMAIL || 'cashier@houndfe.com';
const BASE_URL = process.env.INVENTORY_BASE_URL || 'http://127.0.0.1:3000';

// Loads .env into process.env WITHOUT overriding the shell and without printing.
function loadEnv() {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

function prismaClient() {
  loadEnv();
  const { PrismaClient } = require('@prisma/client');
  return new PrismaClient();
}

function requireEnv(name) {
  const value = process.env[name];
  assert(
    value,
    `${name} must be set (see scripts/inventory-runtime/README.md)`,
  );
  return value;
}

// One HTTP call. Returns { status, body, headers }; body is parsed JSON or text.
async function http(method, route, { token, body, headers = {} } = {}) {
  const response = await fetch(`${BASE_URL}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

// Real auth endpoint. NODE_ENV=development skips the email OTP. A multi-tenant
// or super-admin account lands in the tenant through POST /auth/switch-tenant.
async function login(email, password, tenantId) {
  const res = await http('POST', '/auth/login', { body: { email, password } });
  assert.equal(res.status, 200, `login ${email}: HTTP ${res.status}`);
  let token = res.body.accessToken;
  assert(
    token,
    `login ${email}: no accessToken (OTP flow? NODE_ENV must be development)`,
  );
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  if (claims.tenantId === null && tenantId) {
    const switched = await http('POST', '/auth/switch-tenant', {
      token,
      body: { tenantId },
    });
    assert.equal(
      switched.status,
      200,
      `switch-tenant: HTTP ${switched.status}`,
    );
    token = switched.body.accessToken;
  }
  return token;
}

async function tenantBySlug(prisma, slug = TENANT_SLUG) {
  const tenant = await prisma.tenant.findUnique({ where: { slug } });
  assert(tenant, `tenant ${slug} not found in the dev DB`);
  return tenant;
}

module.exports = {
  root,
  TENANT_SLUG,
  TENANT_NAME,
  DEV_EMAIL,
  NOPERM_EMAIL,
  BASE_URL,
  loadEnv,
  prismaClient,
  requireEnv,
  http,
  login,
  tenantBySlug,
};
