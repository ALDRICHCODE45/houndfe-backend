const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { openRelay } = require('./relay.cjs');
const target = {
  containerId: 'a'.repeat(64),
  imageId:
    'sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb',
  owner: 'draft-0123456789abcdef',
  name: 'editorial-coordination-draft-0123456789abcdef',
  host: '127.0.0.1',
  port: 0,
};
const networkId = 'b'.repeat(64);
const bounded = { timeout: 5000 };
function observations() {
  return {
    container: {
      id: target.containerId,
      image: target.imageId,
      name: '/' + target.name,
      owner: target.owner,
      running: true,
      mounts: [{ Type: 'tmpfs' }],
      tmpfs: { '/var/lib/postgresql/data': 'rw,noexec,nosuid,size=256m' },
      ports: { '5432/tcp': null },
      networks: {
        [target.name]: {
          NetworkID: networkId,
          IPAddress: '172.28.0.2',
          Gateway: '172.28.0.1',
        },
      },
    },
    network: {
      id: networkId,
      name: target.name,
      owner: target.owner,
      internal: true,
      driver: 'bridge',
      options: {},
      ipam: [{ Gateway: '172.28.0.1' }],
      containers: { [target.containerId]: { IPv4Address: '172.28.0.2/16' } },
    },
  };
}
const inspect = (data) => async (kind, id) => {
  assert.equal(id, kind === 'container' ? target.containerId : networkId);
  return structuredClone(data[kind]);
};
async function fixture(t, data = observations(), connect) {
  const relay = await openRelay(target, networkId, {
    inspect: inspect(data),
    connect,
  });
  t.after(() => relay.close());
  assert.equal(relay.address, '127.0.0.1');
  assert(relay.port > 0 && ![3000, 5432, 5433].includes(relay.port));
  return relay;
}
async function client(t, relay) {
  const socket = net.createConnection({
    host: relay.address,
    port: relay.port,
  });
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  return socket;
}
test('unpublished internal relay forwards and closes', bounded, async (t) => {
  const sockets = new Set();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on('error', () => {});
    s.pipe(s);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  const destinations = [];
  const relay = await fixture(t, observations(), (options) => {
    destinations.push(options);
    return net.createConnection({
      host: '127.0.0.1',
      port: server.address().port,
    });
  });
  const socket = await client(t, relay);
  const payload = Buffer.alloc(1024 * 1024, 73);
  const chunks = [];
  let size = 0;
  const received = new Promise((resolve) =>
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size === payload.length) resolve(Buffer.concat(chunks));
    }),
  );
  socket.write(payload);
  assert.deepEqual(await received, payload);
  assert.deepEqual(destinations, [{ host: '172.28.0.2', port: 5432 }]);
  const ended = once(socket, 'close');
  await Promise.all([relay.close(), relay.close()]);
  await ended;
  assert.equal(socket.destroyed, true);
});
for (const field of ['mounts', 'gateway'])
  test(`admits Docker internal ${field} representation`, bounded, async (t) => {
    const data = observations();
    if (field === 'mounts') data.container.mounts = [];
    else data.container.networks[target.name].Gateway = '';
    await fixture(t, data);
  });
test('identity rejection occurs before any upstream connection', async (t) => {
  const endpoint = `container.networks.${target.name}`;
  const member = `network.containers.${target.containerId}`;
  for (const [section, key, value] of [
    ['container', 'tmpfs', null],
    ['container', 'tmpfs', {}],
    ['container.tmpfs', '/var/lib/postgresql/data', 'rw,size=256m'],
    ['container.tmpfs', '/other', 'rw,noexec,nosuid,size=256m'],
    ['network.ipam.0', 'Gateway', 'invalid'],
    [endpoint, 'Gateway', null],
    ['container', 'image', 'wrong'],
    ['container', 'owner', 'wrong'],
    ['container', 'running', false],
    ['container.mounts.0', 'Type', 'bind'],
    ['container.ports', '5432/tcp', [{ HostIp: '0.0.0.0' }]],
    ['container.networks', 'other', {}],
    ['network', 'id', 'c'.repeat(64)],
    ['network', 'owner', 'wrong'],
    ['network', 'internal', false],
    ['network', 'driver', 'overlay'],
    [
      'network.options',
      'com.docker.network.bridge.gateway_mode_ipv4',
      'isolated',
    ],
    ['network.containers', 'other', {}],
    [member, 'IPv4Address', '172.28.0.3/16'],
    [endpoint, 'IPAddress', 'bad'],
    [endpoint, 'Gateway', '172.29.0.1'],
  ])
    await t.test(`${section}.${key}`, async () => {
      const data = observations();
      const object = section
        .split('.')
        .reduce((value, key) => value[key], data);
      object[key] = value;
      const connect = t.mock.fn();
      await assert.rejects(async () => {
        const relay = await openRelay(target, networkId, {
          inspect: inspect(data),
          connect,
        });
        await relay.close();
      }, /Disposable relay denied/);
      assert.equal(connect.mock.callCount(), 0);
    });
});
test('rejects stale identity', bounded, async (t) => {
  const data = observations();
  const connect = t.mock.fn();
  const relay = await fixture(t, data, connect);
  data.container.id = 'c'.repeat(64);
  const socket = await client(t, relay);
  await once(socket, 'close');
  assert.equal(connect.mock.callCount(), 0);
});
test('contains errors and repeated shutdown', bounded, async (t) => {
  await assert.rejects(
    openRelay(target, networkId, {
      inspect: async () => {
        throw Error('private detail');
      },
    }),
    /^Error: Disposable relay denied$/,
  );
  const relay = await fixture(t, observations(), () => {
    throw Error('connect failed');
  });
  const socket = await client(t, relay);
  await once(socket, 'close');
  await relay.close();
  await relay.close();
});
test('caps clients and cancels admission', bounded, async (t) => {
  let pending = false;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const connect = t.mock.fn();
  const relay = await openRelay(target, networkId, {
    inspect: async (kind) => {
      if (pending) await gate;
      return observations()[kind];
    },
    connect,
  });
  t.after(() => relay.close());
  pending = true;
  const clients = [];
  for (let i = 0; i < 8; i++) clients.push(await client(t, relay));
  const rejected = await client(t, relay);
  await once(rejected, 'close');
  const closed = clients.map((s) => once(s, 'close'));
  await relay.close();
  release();
  await Promise.all(closed);
  assert.equal(connect.mock.callCount(), 0);
});
