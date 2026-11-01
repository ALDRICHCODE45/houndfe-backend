const assert = require('node:assert/strict');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const IMAGE =
  'sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb';
const formats = {
  container:
    '{"id":{{json .Id}},"image":{{json .Image}},"name":{{json .Name}},"owner":{{json (index .Config.Labels "editorial.owner")}},"running":{{json .State.Running}},"mounts":{{json .Mounts}},"tmpfs":{{json .HostConfig.Tmpfs}},"networks":{{json .NetworkSettings.Networks}},"ports":{{json .NetworkSettings.Ports}}}',
  network:
    '{"id":{{json .Id}},"name":{{json .Name}},"owner":{{json (index .Labels "editorial.owner")}},"internal":{{json .Internal}},"driver":{{json .Driver}},"containers":{{json .Containers}},"options":{{json .Options}},"ipam":{{json .IPAM.Config}}}',
};
async function inspectDocker(kind, id) {
  const { stdout } = await promisify(execFile)(
    'docker',
    [
      '--host',
      'unix:///var/run/docker.sock',
      kind,
      'inspect',
      id,
      '--format',
      formats[kind],
    ],
    { timeout: 5000, maxBuffer: 65536 },
  );
  return JSON.parse(stdout);
}
// Dependency seams are offline-test-only; the host always uses these defaults.
exports.openRelay = async function openRelay(
  target,
  networkId,
  dependencies = {},
) {
  const pin = { ...target };
  const inspect = dependencies.inspect || inspectDocker;
  const connect = dependencies.connect || net.createConnection;
  async function admit() {
    try {
      assert(/^[a-f0-9]{64}$/.test(pin.containerId));
      assert(/^[a-f0-9]{64}$/.test(networkId));
      assert(/^draft-[a-f0-9]{16}$/.test(pin.owner));
      assert.equal(pin.name, 'editorial-coordination-' + pin.owner);
      assert.equal(pin.imageId, IMAGE);
      assert.equal(pin.host, '127.0.0.1');
      assert.equal(pin.port, 0);
      const [container, network] = await Promise.all([
        inspect('container', pin.containerId),
        inspect('network', networkId),
      ]);
      assert.equal(container.id, pin.containerId);
      assert.equal(container.image, IMAGE);
      assert.equal(container.name, '/' + pin.name);
      assert.equal(container.owner, pin.owner);
      assert.equal(container.running, true);
      assert.deepEqual(container.tmpfs, {
        '/var/lib/postgresql/data': 'rw,noexec,nosuid,size=256m',
      });
      assert(container.mounts.every((mount) => mount.Type === 'tmpfs'));
      assert(Object.values(container.ports).every((port) => port === null));
      assert.deepEqual(Object.keys(container.networks), [pin.name]);
      assert.equal(network.id, networkId);
      assert.equal(network.name, pin.name);
      assert.equal(network.owner, pin.owner);
      assert.equal(network.internal, true);
      assert.equal(network.driver, 'bridge');
      const mode =
        network.options['com.docker.network.bridge.gateway_mode_ipv4'];
      assert(mode === undefined || mode === 'nat');
      assert.deepEqual(Object.keys(network.containers), [pin.containerId]);
      const endpoint = container.networks[pin.name];
      assert.equal(endpoint.NetworkID, networkId);
      assert.equal(net.isIP(endpoint.IPAddress), 4);
      assert.equal(network.ipam.length, 1);
      const gateway = network.ipam[0].Gateway;
      assert.equal(net.isIP(gateway), 4);
      assert.notEqual(endpoint.IPAddress, gateway);
      assert(endpoint.Gateway === '' || endpoint.Gateway === gateway);
      assert.equal(
        network.containers[pin.containerId].IPv4Address.split('/')[0],
        endpoint.IPAddress,
      );
      return endpoint.IPAddress;
    } catch {
      throw new Error('Disposable relay denied');
    }
  }
  const address = await admit();
  let stopped = false;
  let closing;
  const sockets = new Set();
  const server = net.createServer((incoming) => {
    if (stopped || sockets.size >= 16) return incoming.destroy();
    sockets.add(incoming);
    let upstream;
    const destroy = () => {
      incoming.destroy();
      upstream?.destroy();
      sockets.delete(incoming);
      if (upstream) sockets.delete(upstream);
    };
    incoming.on('error', destroy).on('close', destroy);
    incoming.setTimeout(6000, destroy);
    void (async () => {
      assert.equal(await admit(), address);
      if (stopped || incoming.destroyed) return;
      upstream = connect({ host: address, port: 5432 });
      sockets.add(upstream);
      upstream.on('error', destroy).on('close', destroy);
      upstream.setTimeout(5000, destroy);
      upstream.once('connect', () => {
        incoming.setTimeout(0);
        upstream.setTimeout(0);
        incoming.pipe(upstream).pipe(incoming);
      });
    })().catch(destroy);
  });
  // Pending admissions count as connections too, before their upstream exists.
  server.maxConnections = 8;
  server.dropMaxConnection = true;
  const close = () => {
    if (closing) return closing;
    stopped = true;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    closing = new Promise((resolve) => server.close(() => resolve()));
    return closing;
  };
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const bound = server.address();
    assert(![3000, 5432, 5433].includes(bound.port));
    server.on('error', () => {
      void close();
    });
    return { address: bound.address, port: bound.port, close };
  } catch {
    await close();
    throw new Error('Disposable relay denied');
  }
};
