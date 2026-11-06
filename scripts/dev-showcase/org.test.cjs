// Offline: `node --test scripts/dev-showcase/org.test.cjs` (fake Prisma, no DB).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { ensureUser, DEMO_PASSWORD, DEMO_USERS } = require('./org.cjs');

const spec = DEMO_USERS[0];
const tenant = { id: 'tenant-1' };
const role = { id: 'role-1' };

function fakePrisma(existing) {
  const calls = { create: [], update: [] };
  const prisma = {
    user: {
      findUnique: async () => existing,
      create: async ({ data }) => {
        calls.create.push(data);
        return data;
      },
      update: async (args) => {
        calls.update.push(args);
        return { ...existing, ...args.data };
      },
    },
    tenantMembership: { upsert: async () => ({}) },
  };
  return { prisma, calls };
}

test('without the flag an existing user keeps their password', async () => {
  const { prisma, calls } = fakePrisma({ id: 'u1', hashedPassword: 'old' });
  const result = await ensureUser(prisma, spec, tenant, role, {
    resetPassword: false,
  });
  assert.deepEqual(result, { created: false, passwordReset: false });
  assert.equal(calls.update.length, 0);
  assert.equal(calls.create.length, 0);
});

test('with the flag an existing user gets the demo password re-hashed', async () => {
  const { prisma, calls } = fakePrisma({ id: 'u1', hashedPassword: 'old' });
  const result = await ensureUser(prisma, spec, tenant, role, {
    resetPassword: true,
  });
  assert.deepEqual(result, { created: false, passwordReset: true });
  assert.equal(calls.update.length, 1);
  const [{ where, data }] = calls.update;
  assert.deepEqual(where, { id: 'u1' });
  assert.deepEqual(Object.keys(data), ['hashedPassword']);
  assert.notEqual(data.hashedPassword, DEMO_PASSWORD);
  assert.equal(await bcrypt.compare(DEMO_PASSWORD, data.hashedPassword), true);
});

test('a new user is created with the demo password, never reported as reset', async () => {
  const { prisma, calls } = fakePrisma(null);
  const result = await ensureUser(prisma, spec, tenant, role, {
    resetPassword: true,
  });
  assert.deepEqual(result, { created: true, passwordReset: false });
  assert.equal(calls.update.length, 0);
  assert.equal(
    await bcrypt.compare(DEMO_PASSWORD, calls.create[0].hashedPassword),
    true,
  );
});

test('the flag is read from SHOWCASE_RESET_PASSWORDS=1 only', () => {
  const { execFileSync } = require('node:child_process');
  const probe = (value) =>
    execFileSync(
      process.execPath,
      [
        '-e',
        "require('./org.cjs').ensureUser({user:{findUnique:async()=>({id:'u'}),update:async()=>{console.log('reset')}},tenantMembership:{upsert:async()=>({})}},{email:'x'},{id:'t'},{id:'r'})",
      ],
      {
        cwd: __dirname,
        env: { ...process.env, SHOWCASE_RESET_PASSWORDS: value },
        encoding: 'utf8',
      },
    ).trim();
  assert.equal(probe('1'), 'reset');
  assert.equal(probe('true'), '');
  assert.equal(probe(''), '');
});
