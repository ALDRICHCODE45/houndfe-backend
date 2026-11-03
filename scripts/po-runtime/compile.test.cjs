'use strict';
// Real Nest DI graph, no app initialization/listener or real Prisma provider.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Socket } = require('node:net');
const root = path.resolve(__dirname, '../..');
for (const file of ['.env', '.env.test', 'prisma/.env'])
  assert(!fs.existsSync(path.join(root, file)), 'Env file must be absent');
// No ambient credentials are inherited by provider constructors or SDKs.
process.env = {
  ...(process.env.NODE_TEST_CONTEXT
    ? { NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT }
    : {}),
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://offline:offline@127.0.0.1:1/nest-practice-test',
  COREPACK_ENABLE_NETWORK: '0',
  PRISMA_GENERATE_SKIP_AUTOINSTALL: 'true',
};
const {
  createHostBuilder,
  hostFailureDiagnostic,
} = require('../supplier-runtime/host.cjs');
for (const po of [false, true]) {
  test(`real ${po ? 'PO' : 'supplier-only'} Nest graph compiles without connecting or initializing`, async () => {
    let calls = 0;
    const forbidden = () => {
      calls++;
      throw new Error('Offline Prisma/lifecycle access forbidden');
    };
    let socketCalls = 0;
    const connect = Socket.prototype.connect;
    Socket.prototype.connect = () => {
      socketCalls++;
      throw new Error('Offline socket connection forbidden');
    };
    const prisma = Object.freeze({
      $connect: forbidden,
      $disconnect: forbidden,
      $queryRaw: forbidden,
      $executeRaw: forbidden,
      $transaction: forbidden,
      onModuleInit: forbidden,
      onApplicationBootstrap: forbidden,
    });
    let module;
    try {
      const builder = createHostBuilder(po);
      const { PrismaService } = require(
        path.join(root, 'dist/shared/prisma/prisma.service.js'),
      );
      // Replaces EVERY PrismaService registration (including OutboxModule's local one).
      builder.overrideProvider(PrismaService).useValue(prisma);
      module = await builder.compile();
      assert(
        module
          .get(PrismaService, { each: true })
          .every((provider) => provider === prisma),
      );
      assert.equal(calls, 0);
      assert.equal(socketCalls, 0);
      console.log(
        `PASS ${po ? 'PO' : 'supplier-only'} compile; Prisma/lifecycle calls: ${calls}; socket calls: ${socketCalls}`,
      );
    } catch (error) {
      const diagnostic = hostFailureDiagnostic('compile-module', error);
      console.log(
        `Nest DI ${po ? 'PO' : 'supplier-only'}: ${diagnostic.diMessage || diagnostic.errorName}`,
      );
      throw new Error(`Offline compile failed: ${JSON.stringify(diagnostic)}`);
    } finally {
      // close() does not initialize; the stub has no destroy/disconnect hook.
      try {
        if (module) await module.close();
      } finally {
        Socket.prototype.connect = connect;
      }
      assert.equal(calls, 0);
      assert.equal(socketCalls, 0);
    }
  });
}
