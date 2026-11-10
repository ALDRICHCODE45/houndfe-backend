import { EventEmitter } from 'node:events';
import {
  PgNotificationListener,
  pgClientConfig,
  type PgListenClient,
} from './pg-notification-listener';

class FakeClient extends EventEmitter implements PgListenClient {
  processID = 4242;
  queries: string[] = [];
  ended = false;
  heartbeats = 0;
  /** What `SELECT 1` does: answer, fail, or never answer (half-open socket). */
  heartbeat: 'ok' | 'fail' | 'hang' = 'ok';
  constructor(private readonly failConnect = false) {
    super();
  }
  connect() {
    return this.failConnect
      ? Promise.reject(new Error('refused'))
      : Promise.resolve();
  }
  query(sql: string) {
    if (sql === 'SELECT 1') {
      this.heartbeats++;
      if (this.heartbeat === 'fail') return Promise.reject(new Error('reset'));
      if (this.heartbeat === 'hang') return new Promise<void>(() => undefined);
      return Promise.resolve();
    }
    this.queries.push(sql);
    return Promise.resolve();
  }
  end() {
    this.ended = true;
    return Promise.resolve();
  }
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(check()).toBe(true);
};

function build(clients: FakeClient[]) {
  const created: FakeClient[] = [];
  const listener = new PgNotificationListener({
    initialBackoffMs: 1,
    maxBackoffMs: 4,
    heartbeatMs: 5,
    heartbeatTimeoutMs: 20,
    createClient: () => {
      const client = clients[created.length] ?? new FakeClient();
      created.push(client);
      return client;
    },
  });
  return { listener, created };
}

describe('PgNotificationListener (R7)', () => {
  it('connects lazily, LISTENs and dispatches the payload by channel', async () => {
    const first = new FakeClient();
    const { listener, created } = build([first]);
    expect(created).toHaveLength(0);
    const seen: string[] = [];
    listener.subscribe('chatbot_feed', (payload) => seen.push(payload));
    listener.subscribe('other_channel', () => seen.push('wrong'));
    await listener.start();
    expect(first.queries).toEqual([
      'LISTEN "chatbot_feed"',
      'LISTEN "other_channel"',
    ]);
    first.emit('notification', {
      channel: 'chatbot_feed',
      payload: 'tenant-1',
    });
    expect(seen).toEqual(['tenant-1']);
    expect(listener.backendPid).toBe(4242);
    await listener.close();
  });

  it('stops delivering after unsubscribe', async () => {
    const first = new FakeClient();
    const { listener } = build([first]);
    const seen: string[] = [];
    const off = listener.subscribe('chatbot_feed', (p) => seen.push(p));
    await listener.start();
    off();
    first.emit('notification', { channel: 'chatbot_feed', payload: 'x' });
    expect(seen).toEqual([]);
    await listener.close();
  });

  it('reconnects after the connection ends, re-LISTENs and announces it', async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    const { listener, created } = build([first, second]);
    let connected = 0;
    listener.onConnected(() => connected++);
    listener.subscribe('chatbot_feed', () => undefined);
    await listener.start();
    expect(connected).toBe(1);
    first.emit('end');
    await until(() => created.length === 2 && connected === 2);
    expect(second.queries).toEqual(['LISTEN "chatbot_feed"']);
    await listener.close();
  });

  it('keeps retrying with backoff while the database refuses', async () => {
    const { listener, created } = build([
      new FakeClient(true),
      new FakeClient(true),
    ]);
    let connected = 0;
    listener.onConnected(() => connected++);
    listener.subscribe('chatbot_feed', () => undefined);
    await listener.start();
    await until(() => connected === 1);
    expect(created.length).toBeGreaterThanOrEqual(3);
    await listener.close();
  });

  it('does not reconnect after close and ends the client', async () => {
    const first = new FakeClient();
    const { listener, created } = build([first]);
    listener.subscribe('chatbot_feed', () => undefined);
    await listener.start();
    await listener.close();
    first.emit('end');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(first.ended).toBe(true);
    expect(created).toHaveLength(1);
  });

  it('rejects a channel name that is not a plain identifier', () => {
    const { listener } = build([]);
    expect(() =>
      listener.subscribe('x"; DROP TABLE y', () => undefined),
    ).toThrow();
  });

  describe('heartbeat (M2: a half-open socket raises no error)', () => {
    it('keeps probing a healthy connection without reconnecting', async () => {
      const first = new FakeClient();
      const { listener, created } = build([first]);
      listener.subscribe('chatbot_feed', () => undefined);
      await listener.start();
      await until(() => first.heartbeats >= 3);
      expect(created).toHaveLength(1);
      await listener.close();
    });

    it('reconnects, re-LISTENs and announces it when the heartbeat fails', async () => {
      const first = new FakeClient();
      first.heartbeat = 'fail';
      const second = new FakeClient();
      const { listener, created } = build([first, second]);
      let connected = 0;
      listener.onConnected(() => connected++);
      listener.subscribe('chatbot_feed', () => undefined);
      await listener.start();
      await until(() => created.length === 2 && connected === 2);
      expect(first.ended).toBe(true);
      expect(second.queries).toEqual(['LISTEN "chatbot_feed"']);
      await listener.close();
    });

    it('treats a heartbeat that never answers as lost (timeout)', async () => {
      const first = new FakeClient();
      first.heartbeat = 'hang';
      const { listener, created } = build([first, new FakeClient()]);
      listener.subscribe('chatbot_feed', () => undefined);
      await listener.start();
      await until(() => created.length === 2);
      expect(first.ended).toBe(true);
      await listener.close();
    });

    it('stops probing after close', async () => {
      const first = new FakeClient();
      const { listener } = build([first]);
      listener.subscribe('chatbot_feed', () => undefined);
      await listener.start();
      await listener.close();
      const seen = first.heartbeats;
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(first.heartbeats).toBe(seen);
    });
  });
});

describe('pgClientConfig', () => {
  it('turns keepAlive on with a 10 s initial delay and bounds the connect', () => {
    expect(pgClientConfig('postgres://u:p@db:5432/app')).toEqual({
      connectionString: 'postgres://u:p@db:5432/app',
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
  });
});
