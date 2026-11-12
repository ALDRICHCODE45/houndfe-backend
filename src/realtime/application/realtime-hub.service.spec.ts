/**
 * Unit spec of the per-replica fan-out (unit 8; contract §5.3, §10.1 R5/R7/R12):
 * replay from `Last-Event-ID`, live delivery on `NOTIFY`, per-recipient
 * shaping, access re-check on every delivery, tenant isolation, connection
 * limits, LISTEN reconnects and failure recovery. The store, shaper, access and
 * LISTEN connection are doubles; the real ones are proven in
 * `realtime-stream.integration.spec.ts`.
 */
import { Logger } from '@nestjs/common';
import { STREAM_LIMITS, type SseFrame } from '../domain/realtime-events';
import type { RealtimeEventRow } from '../infrastructure/prisma-realtime-event.store';
import type { AccessPort, AccessResult } from './realtime-access';
import { AccessGate } from './realtime-access';
import {
  RealtimeHub,
  type HubListener,
  type HubShaper,
  type HubStore,
} from './realtime-hub.service';
import type { StreamSink } from './realtime-stream';

class FakeSink implements StreamSink {
  chunks: string[] = [];
  ended = false;
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  end(chunk?: string): void {
    if (chunk) this.chunks.push(chunk);
    this.ended = true;
  }
  destroy(): void {
    this.ended = true;
  }
  get bufferedBytes(): number {
    return 0;
  }
  onDrain(): void {}
  get text(): string {
    return this.chunks.join('');
  }
  /** `event:id` of each frame, in order, without heartbeats and preamble. */
  get events(): string[] {
    return this.text
      .split('\n\n')
      .filter((frame) => frame.includes('event: '))
      .filter((frame) => !frame.includes('event: heartbeat'))
      .map((frame) => {
        const id = /^id: (\d+)$/m.exec(frame)?.[1];
        const event = /^event: (.+)$/m.exec(frame)?.[1] ?? '';
        return id ? `${event}:${id}` : event;
      });
  }
}

class FakeStore implements HubStore {
  rows: RealtimeEventRow[] = [];
  purged = new Map<string, bigint>();
  reads: Array<{ tenant: string; user: string | null; after: bigint }> = [];
  failReads = 0;
  private nextId = 1n;
  hold: Promise<void> | null = null;
  /**
   * Holds the per-user (replay) reads AFTER they computed their result, so the
   * replay sees the log as it was when it read, whatever commits while it waits.
   */
  holdReplayReads: Promise<void> | null = null;

  add(
    tenantId: string,
    type: string,
    over: Partial<RealtimeEventRow> = {},
  ): RealtimeEventRow {
    const row: RealtimeEventRow = {
      id: this.nextId++,
      tenantId,
      userId: null,
      type,
      requestId: 'r-1',
      payload: { version: 1 },
      createdAt: new Date(),
      ...over,
    };
    this.rows.push(row);
    return row;
  }

  tenantHead(tenantId: string): Promise<bigint> {
    const mine = this.rows.filter((r) => r.tenantId === tenantId);
    return Promise.resolve(mine.at(-1)?.id ?? 0n);
  }
  purgedThrough(tenantId: string): Promise<bigint> {
    return Promise.resolve(this.purged.get(tenantId) ?? 0n);
  }
  async readAfter(
    tenantId: string,
    userId: string | null,
    after: bigint,
    limit: number,
  ): Promise<RealtimeEventRow[]> {
    this.reads.push({ tenant: tenantId, user: userId, after });
    if (this.hold) await this.hold;
    if (this.failReads > 0) {
      this.failReads -= 1;
      throw new Error('db down');
    }
    const result = this.rows
      .filter(
        (r) =>
          r.tenantId === tenantId &&
          r.id > after &&
          (userId === null || r.userId === null || r.userId === userId),
      )
      .slice(0, limit);
    if (userId !== null && this.holdReplayReads) await this.holdReplayReads;
    return result;
  }
}

class FakeListener implements HubListener {
  handlers: Array<(payload: string) => void> = [];
  connected: Array<() => void> = [];
  started = 0;
  start(): Promise<void> {
    this.started += 1;
    return Promise.resolve();
  }
  subscribe(_channel: string, handler: (payload: string) => void) {
    this.handlers.push(handler);
    return () => undefined;
  }
  onConnected(handler: () => void) {
    this.connected.push(handler);
    return () => undefined;
  }
  notify(tenantId: string): void {
    for (const handler of this.handlers) handler(tenantId);
  }
  reconnect(): void {
    for (const handler of this.connected) handler();
  }
}

const ALLOW = { can: () => true };

/** The shaper double: the frame says who it was built for. */
const shaper = (): HubShaper & {
  prepared: number;
  audiences: string[][];
  failPrepare: number;
  prepareGate: Promise<void> | null;
  skip: Set<bigint>;
} => {
  const state = {
    prepared: 0,
    audiences: [] as string[][],
    failPrepare: 0,
    prepareGate: null as Promise<void> | null,
    skip: new Set<bigint>(),
    prepare: async (
      _tenant: string,
      events: RealtimeEventRow[],
      audience: ReadonlySet<string>,
    ) => {
      state.prepared += 1;
      state.audiences.push([...audience].sort());
      if (state.prepareGate) await state.prepareGate;
      if (state.failPrepare > 0) {
        state.failPrepare -= 1;
        throw new Error('prepare failed');
      }
      return { count: events.length, audience };
    },
    shape: (
      prepared: unknown,
      event: RealtimeEventRow,
      reader: { userId: string },
    ): SseFrame | null => {
      // Like the real shaper: a personal view exists only for the audience.
      const { audience } = prepared as { audience: ReadonlySet<string> };
      if (event.userId !== null && !audience.has(reader.userId)) return null;
      return state.skip.has(event.id)
        ? null
        : {
            id: event.id,
            event: event.type,
            data: { for: reader.userId, v: event.payload },
          };
    },
  };
  return state;
};

const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
};
/** Lets timers and the promise chains they start settle. */
const settle = async () => {
  await jest.advanceTimersByTimeAsync(0);
  await flush(20);
};

function setup(
  over: {
    access?: AccessPort;
    maxStreamsPerReplica?: number;
  } = {},
) {
  const store = new FakeStore();
  const listener = new FakeListener();
  const shape = shaper();
  const accessCalls: string[] = [];
  const access: AccessPort =
    over.access ??
    ({
      check: (tenant, user) => {
        accessCalls.push(`${tenant}:${user}`);
        return Promise.resolve({ ok: true, ability: ALLOW });
      },
    } as AccessPort);
  const hub = new RealtimeHub(
    listener,
    store,
    shape,
    new AccessGate(access, Date.now, 0),
    {
      limits: { maxStreamsPerReplica: over.maxStreamsPerReplica ?? 1000 },
      failureBackoffMs: 100,
    },
  );
  const open = async (
    tenantId: string,
    userId: string,
    after: bigint | null = null,
    expiresAtMs = Date.now() + 15 * 60_000,
  ) => {
    const sink = new FakeSink();
    const handle = await hub.connect({
      tenantId,
      userId,
      ability: ALLOW,
      sink,
      after,
      expiresAtMs,
    });
    await settle();
    return { sink, handle };
  };
  return { hub, store, listener, shape, accessCalls, open };
}

describe('RealtimeHub', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-11-11T12:00:00Z') });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('connect without a cursor', () => {
    it('says ready with the current cursor and delivers what commits afterwards', async () => {
      const { store, listener, open, hub } = setup();
      store.add('t1', 'request.created'); // before the connection: not sent
      const { sink } = await open('t1', 'u1');
      expect(sink.events).toEqual(['ready:1']);
      expect(sink.text).toContain('"heartbeatSeconds":15');
      store.add('t1', 'request.claimed');
      listener.notify('t1');
      await settle();
      expect(sink.events).toEqual(['ready:1', 'request.claimed:2']);
      expect(sink.text).toContain('"for":"u1"');
      await hub.onModuleDestroy();
    });

    it('opens the LISTEN connection once and subscribes once for the replica', async () => {
      const { listener, open, hub } = setup();
      await open('t1', 'u1');
      await open('t1', 'u2');
      await open('t2', 'u3');
      expect(listener.handlers).toHaveLength(1);
      expect(listener.connected).toHaveLength(1);
      await hub.onModuleDestroy();
    });
  });

  describe('replay', () => {
    it('sends what is after Last-Event-ID, oldest first, then goes live', async () => {
      const { store, listener, open, hub } = setup();
      store.add('t1', 'request.created');
      store.add('t1', 'request.claimed');
      store.add('t1', 'request.resolved');
      const { sink } = await open('t1', 'u1', 1n);
      expect(sink.events).toEqual(['request.claimed:2', 'request.resolved:3']);
      store.add('t1', 'request.updated');
      listener.notify('t1');
      await settle();
      expect(sink.events.at(-1)).toBe('request.updated:4');
      await hub.onModuleDestroy();
    });

    it('never repeats an event that arrives both in the replay and live', async () => {
      const { store, listener, open, hub } = setup();
      store.add('t1', 'request.created');
      let release: () => void = () => undefined;
      store.hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const opening = open('t1', 'u1', 0n);
      await flush();
      // Commits while the replay is still reading.
      store.add('t1', 'request.claimed');
      listener.notify('t1');
      await flush();
      release();
      store.hold = null;
      const { sink } = await opening;
      await settle();
      expect(sink.events).toEqual(['request.created:1', 'request.claimed:2']);
      await hub.onModuleDestroy();
    });

    it('answers resync CURSOR_EXPIRED when the cursor is older than the retention', async () => {
      const { store, open, hub } = setup();
      for (let i = 0; i < 4; i += 1) store.add('t1', 'request.updated');
      store.purged.set('t1', 3n);
      const { sink } = await open('t1', 'u1', 2n);
      expect(sink.events).toEqual(['resync:4']);
      expect(sink.text).toContain('"reason":"CURSOR_EXPIRED"');
      expect(sink.ended).toBe(false);
      await hub.onModuleDestroy();
    });

    it('a cursor exactly at the watermark is fine (nothing was skipped)', async () => {
      const { store, open, hub } = setup();
      for (let i = 0; i < 4; i += 1) store.add('t1', 'request.updated');
      store.purged.set('t1', 2n);
      const { sink } = await open('t1', 'u1', 2n);
      expect(sink.events).toEqual(['request.updated:3', 'request.updated:4']);
      await hub.onModuleDestroy();
    });

    it('answers resync REPLAY_TOO_LARGE past the page limit, and stays open', async () => {
      const { store, open, hub } = setup();
      const total =
        STREAM_LIMITS.replayPageSize * STREAM_LIMITS.replayMaxPages + 10;
      for (let i = 0; i < total; i += 1) store.add('t1', 'request.updated');
      const { sink } = await open('t1', 'u1', 0n);
      expect(sink.events).toEqual([`resync:${total}`]);
      expect(sink.text).toContain('"reason":"REPLAY_TOO_LARGE"');
      expect(sink.ended).toBe(false);
      await hub.onModuleDestroy();
    });

    it('replays exactly the page budget when it fits', async () => {
      const { store, open, hub } = setup();
      const total = STREAM_LIMITS.replayPageSize * STREAM_LIMITS.replayMaxPages;
      for (let i = 0; i < total; i += 1) store.add('t1', 'request.updated');
      const { sink } = await open('t1', 'u1', 0n);
      expect(sink.events).toHaveLength(total);
      expect(sink.text).not.toContain('resync');
      await hub.onModuleDestroy();
    });
  });

  describe('audience and tenant isolation', () => {
    it('broadcast events reach everyone, personal events only their user', async () => {
      const { store, listener, open, hub } = setup();
      const ana = await open('t1', 'ana');
      const luis = await open('t1', 'luis');
      store.add('t1', 'request.created');
      store.add('t1', 'notification.created', {
        userId: 'ana',
        payload: { notificationId: 'n1' },
      });
      listener.notify('t1');
      await settle();
      expect(ana.sink.events.slice(1)).toEqual([
        'request.created:1',
        'notification.created:2',
      ]);
      expect(luis.sink.events.slice(1)).toEqual(['request.created:1']);
      expect(luis.sink.text).not.toContain('n1');
      await hub.onModuleDestroy();
    });

    it('an event of another tenant never reaches the stream', async () => {
      const { store, listener, open, hub } = setup();
      const a = await open('t1', 'u1');
      const b = await open('t2', 'u1');
      store.add('t2', 'request.created');
      listener.notify('t2');
      await settle();
      expect(a.sink.events).toEqual(['ready']);
      expect(b.sink.events).toEqual(['ready', 'request.created:1']);
      // The other tenant's notify does not even read for tenant t1.
      expect(
        store.reads.every((r) => r.tenant !== 't1' || r.after === 0n),
      ).toBe(true);
      await hub.onModuleDestroy();
    });

    it('reads once per notification and prepares once, however many streams', async () => {
      const { store, listener, shape, open, hub } = setup();
      for (const user of ['a', 'b', 'c']) await open('t1', user);
      const before = store.reads.filter((r) => r.user === null).length;
      store.add('t1', 'request.created');
      listener.notify('t1');
      await settle();
      expect(store.reads.filter((r) => r.user === null).length - before).toBe(
        1,
      );
      expect(shape.prepared).toBe(1);
      await hub.onModuleDestroy();
    });

    it('builds the frame per recipient', async () => {
      const { store, listener, open, hub } = setup();
      const ana = await open('t1', 'ana');
      const luis = await open('t1', 'luis');
      store.add('t1', 'request.created');
      listener.notify('t1');
      await settle();
      expect(ana.sink.text).toContain('"for":"ana"');
      expect(ana.sink.text).not.toContain('"for":"luis"');
      expect(luis.sink.text).toContain('"for":"luis"');
      await hub.onModuleDestroy();
    });

    it('a row the recipient cannot read is skipped, and the cursor still advances', async () => {
      const { store, listener, shape, open, hub } = setup();
      const { sink } = await open('t1', 'u1');
      const hidden = store.add('t1', 'request.created');
      shape.skip.add(hidden.id);
      store.add('t1', 'request.updated');
      listener.notify('t1');
      await settle();
      expect(sink.events).toEqual(['ready', 'request.updated:2']);
      await hub.onModuleDestroy();
    });
  });

  describe('access re-check on every delivery (R5)', () => {
    it('closes a revoked user with access-revoked, delivers nothing, spares the others', async () => {
      const revoked: AccessResult = {
        ok: false,
        reason: 'PERMISSION_REVOKED',
      };
      const { store, listener, open, hub } = setup({
        access: {
          check: (_tenant, user) =>
            Promise.resolve(
              user === 'ana' ? revoked : { ok: true, ability: ALLOW },
            ),
        },
      });
      const ana = await open('t1', 'ana');
      const luis = await open('t1', 'luis');
      store.add('t1', 'request.created');
      listener.notify('t1');
      await settle();
      expect(ana.sink.text).toContain(
        'event: access-revoked\ndata: {"reason":"PERMISSION_REVOKED"}',
      );
      expect(ana.sink.text).not.toContain('request.created');
      expect(ana.sink.ended).toBe(true);
      expect(luis.sink.events).toEqual(['ready', 'request.created:1']);
      expect(luis.sink.ended).toBe(false);
      await hub.onModuleDestroy();
    });

    it('checks each user once per batch, however many streams and events', async () => {
      const { store, listener, accessCalls, open, hub } = setup();
      await open('t1', 'ana');
      await open('t1', 'ana');
      await open('t1', 'luis');
      accessCalls.length = 0;
      store.add('t1', 'request.created');
      store.add('t1', 'request.updated');
      listener.notify('t1');
      await settle();
      expect(accessCalls.sort()).toEqual(['t1:ana', 't1:luis']);
      await hub.onModuleDestroy();
    });

    it('a stream with nothing to receive costs no check', async () => {
      const { store, listener, accessCalls, open, hub } = setup();
      await open('t1', 'ana');
      accessCalls.length = 0;
      store.add('t1', 'notification.created', { userId: 'someone-else' });
      listener.notify('t1');
      await settle();
      expect(accessCalls).toEqual([]);
      await hub.onModuleDestroy();
    });

    it('a stream that goes live while the batch awaits the access checks still gets the batch', async () => {
      // The replay→live gap: the replay read the log BEFORE the row committed
      // (empty), the hub's batch is waiting for the live users' access checks,
      // and the replay finishes (empty buffer → live) before they answer. The
      // stream was `replaying` when the batch collected its users, so it has no
      // check of its own; the rows must still reach it.
      const pending: Array<(r: AccessResult) => void> = [];
      const { store, listener, open, hub } = setup({
        access: {
          check: (_tenant, user) =>
            user === 'live-user'
              ? new Promise<AccessResult>((resolve) => pending.push(resolve))
              : Promise.resolve({ ok: true, ability: ALLOW }),
        },
      });
      store.add('t1', 'request.created'); // id 1: both streams start after it
      // `live-user` is live from the start (nothing to replay, access primed).
      const liveUser = await open('t1', 'live-user');
      // `late` reconnects with Last-Event-ID 1; its replay read is held after
      // it saw the log up to id 1.
      let releaseReplay: () => void = () => undefined;
      store.holdReplayReads = new Promise<void>((resolve) => {
        releaseReplay = resolve;
      });
      const lateOpening = open('t1', 'late', 1n);
      await flush(30);
      // Id 2 commits after the replay read; the batch starts and parks on the
      // access check of `live-user` (the only live stream).
      store.add('t1', 'request.claimed');
      listener.notify('t1');
      await flush(30);
      expect(pending).toHaveLength(1);
      // The replay finishes: empty buffer, so `late` flips to live right now.
      store.holdReplayReads = null;
      releaseReplay();
      const late = await lateOpening;
      expect(late.sink.events).toEqual([]);
      // Now the checks answer; the batch writes to every live stream.
      for (const resolve of pending.splice(0)) {
        resolve({ ok: true, ability: ALLOW });
      }
      await settle();
      expect(liveUser.sink.events).toEqual(['ready:1', 'request.claimed:2']);
      expect(late.sink.events).toEqual(['request.claimed:2']);
      // And it is not delivered twice by a later wake-up.
      listener.notify('t1');
      await settle();
      expect(late.sink.events).toEqual(['request.claimed:2']);
      await hub.onModuleDestroy();
    });

    it('a stream that went live during the checks is revoked when its own check says so', async () => {
      const pending: Array<(r: AccessResult) => void> = [];
      const { store, listener, open, hub } = setup({
        access: {
          check: (_tenant, user) =>
            user === 'live-user'
              ? new Promise<AccessResult>((resolve) => pending.push(resolve))
              : Promise.resolve({ ok: false, reason: 'PERMISSION_REVOKED' }),
        },
      });
      store.add('t1', 'request.created');
      await open('t1', 'live-user');
      let releaseReplay: () => void = () => undefined;
      store.holdReplayReads = new Promise<void>((resolve) => {
        releaseReplay = resolve;
      });
      // The guards primed a fresh allow for `late`; the zero-ttl gate forgets it.
      const lateOpening = open('t1', 'late', 1n);
      await flush(30);
      store.add('t1', 'request.claimed');
      listener.notify('t1');
      await flush(30);
      store.holdReplayReads = null;
      releaseReplay();
      const late = await lateOpening;
      for (const resolve of pending.splice(0)) {
        resolve({ ok: true, ability: ALLOW });
      }
      await settle();
      expect(late.sink.text).toContain('"reason":"PERMISSION_REVOKED"');
      expect(late.sink.text).not.toContain('request.claimed');
      expect(late.sink.ended).toBe(true);
      await hub.onModuleDestroy();
    });

    it('closes a revoked user at connect time of a replay as well', async () => {
      const { store, open, hub } = setup({
        access: {
          check: () =>
            Promise.resolve({ ok: false, reason: 'USER_INACTIVE' } as const),
        },
      });
      store.add('t1', 'request.created');
      // The guards primed a fresh allow at connect; a zero cache then forgets it.
      const { sink } = await open('t1', 'ana', 0n);
      expect(sink.text).toContain('"reason":"USER_INACTIVE"');
      expect(sink.text).not.toContain('request.created');
      expect(sink.ended).toBe(true);
      await hub.onModuleDestroy();
    });
  });

  describe('connection limits (6.4, 12.2)', () => {
    it('the sixth stream of one user replaces the oldest with connection-replaced', async () => {
      const { open, hub } = setup();
      const streams: Array<Awaited<ReturnType<typeof open>>> = [];
      for (let i = 0; i < STREAM_LIMITS.maxStreamsPerUser; i += 1) {
        streams.push(await open('t1', 'ana'));
      }
      const other = await open('t1', 'luis');
      const sixth = await open('t1', 'ana');
      expect(streams[0].sink.text).toContain('event: connection-replaced');
      expect(streams[0].sink.ended).toBe(true);
      for (const kept of [...streams.slice(1), sixth, other]) {
        expect(kept.sink.ended).toBe(false);
      }
      await hub.onModuleDestroy();
    });

    it('the same user in another tenant is a different budget', async () => {
      const { open, hub } = setup();
      const first = await open('t1', 'ana');
      for (let i = 0; i < STREAM_LIMITS.maxStreamsPerUser; i += 1) {
        await open('t2', 'ana');
      }
      expect(first.sink.ended).toBe(false);
      await hub.onModuleDestroy();
    });

    it('never admits more than the cap when connects overlap (the check is repeated after the await)', async () => {
      const { hub } = setup({ maxStreamsPerReplica: 1 });
      const connect = (user: string) =>
        hub.connect({
          tenantId: 't1',
          userId: user,
          ability: ALLOW,
          sink: new FakeSink(),
          after: null,
          expiresAtMs: Date.now() + 60_000,
        });
      const handles = await Promise.all([connect('a'), connect('b')]);
      await settle();
      expect(handles.filter((h) => h !== null)).toHaveLength(1);
      expect(hub.openStreams).toBe(1);
      await hub.onModuleDestroy();
    });

    it('refuses new streams when the replica is full, and frees the slot on close', async () => {
      const { hub, open } = setup({ maxStreamsPerReplica: 2 });
      const a = await open('t1', 'a');
      await open('t1', 'b');
      expect(hub.canAccept()).toBe(false);
      a.handle?.dispose();
      expect(hub.canAccept()).toBe(true);
      await hub.onModuleDestroy();
    });
  });

  describe('LISTEN connection lost and recovered (R7)', () => {
    it('reads from the cursor on reconnect: a NOTIFY lost while down is not lost', async () => {
      const { store, listener, open, hub } = setup();
      const { sink } = await open('t1', 'u1');
      store.add('t1', 'request.created'); // its NOTIFY never arrived
      listener.reconnect();
      await settle();
      expect(sink.events).toEqual(['ready', 'request.created:1']);
      await hub.onModuleDestroy();
    });
  });

  describe('failures', () => {
    it('retries a failed read later and delivers each event once', async () => {
      const { store, listener, open, hub } = setup();
      const { sink } = await open('t1', 'u1');
      store.add('t1', 'request.created');
      store.failReads = 1;
      listener.notify('t1');
      await settle();
      expect(sink.events).toEqual(['ready']);
      await jest.advanceTimersByTimeAsync(150);
      await settle();
      expect(sink.events).toEqual(['ready', 'request.created:1']);
      await hub.onModuleDestroy();
    });

    it('after 5 failed attempts the batch is skipped with an honest resync reason, and the next event flows', async () => {
      const { store, listener, shape, open, hub } = setup();
      const { sink } = await open('t1', 'u1');
      store.add('t1', 'request.created');
      shape.failPrepare = 5;
      listener.notify('t1');
      for (let i = 0; i < 6; i += 1) await jest.advanceTimersByTimeAsync(1_000);
      await settle();
      expect(sink.events).toEqual(['ready', 'resync:1']);
      expect(sink.text).toContain('"reason":"DELIVERY_FAILED"');
      expect(sink.text).not.toContain('REPLAY_TOO_LARGE');
      store.add('t1', 'request.claimed');
      listener.notify('t1');
      await settle();
      expect(sink.events).toEqual(['ready', 'resync:1', 'request.claimed:2']);
      await hub.onModuleDestroy();
    });

    it('keeps serving other tenants while one tenant keeps failing', async () => {
      const { store, listener, open, hub } = setup();
      const bad = await open('t1', 'u1');
      const good = await open('t2', 'u2');
      store.add('t2', 'request.created');
      listener.notify('t2');
      await settle();
      expect(good.sink.events).toEqual(['ready', 'request.created:1']);
      expect(bad.sink.events).toEqual(['ready']);
      await hub.onModuleDestroy();
    });
  });

  describe('what a batch prepares (R12, cost)', () => {
    it('prepares for the users connected on this replica only, closed streams excluded', async () => {
      const { store, listener, shape, open, hub } = setup();
      await open('t1', 'ana');
      await open('t1', 'ana');
      const luis = await open('t1', 'luis');
      const gone = await open('t1', 'gone');
      gone.handle?.dispose();
      shape.audiences.length = 0;
      store.add('t1', 'notification.created', {
        userId: 'someone-elsewhere',
        payload: { notificationId: 'n1' },
      });
      listener.notify('t1');
      await settle();
      expect(shape.audiences).toEqual([['ana', 'luis']]);
      expect(luis.sink.events).toEqual(['ready']);
      await hub.onModuleDestroy();
    });

    it('a replay chunk prepares for its own user alone', async () => {
      const { store, shape, open, hub } = setup();
      store.add('t1', 'request.created');
      await open('t1', 'ana', 0n);
      expect(shape.audiences).toEqual([['ana']]);
      await hub.onModuleDestroy();
    });

    it('a stream that connects while the batch is being prepared still gets its personal event, once', async () => {
      const { store, listener, shape, open, hub } = setup();
      await open('t1', 'ana');
      let release: () => void = () => undefined;
      shape.prepareGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      store.add('t1', 'notification.created', {
        userId: 'luis',
        payload: { notificationId: 'n1' },
      });
      listener.notify('t1');
      await flush(30);
      // luis connects with the batch in flight: not in the audience it built.
      shape.prepareGate = null;
      const luis = await open('t1', 'luis', 0n);
      release();
      await settle();
      expect(luis.sink.events).toEqual(['notification.created:1']);
      await hub.onModuleDestroy();
    });
  });

  describe('lifecycle', () => {
    it('stops reading for a tenant once its last stream is gone', async () => {
      const { store, listener, open, hub } = setup();
      const { handle } = await open('t1', 'u1');
      handle?.dispose();
      const before = store.reads.length;
      store.add('t1', 'request.created');
      listener.notify('t1');
      await settle();
      expect(store.reads).toHaveLength(before);
      await hub.onModuleDestroy();
    });

    it('a stream the client closed is never written again', async () => {
      const { store, listener, open, hub } = setup();
      const a = await open('t1', 'u1');
      const b = await open('t1', 'u2');
      a.handle?.dispose();
      const chunks = a.sink.chunks.length;
      store.add('t1', 'request.created');
      listener.notify('t1');
      await settle();
      expect(a.sink.chunks).toHaveLength(chunks);
      expect(b.sink.events).toEqual(['ready', 'request.created:1']);
      await hub.onModuleDestroy();
    });

    it('shutdown tells every stream and ends it', async () => {
      const { open, hub } = setup();
      const a = await open('t1', 'u1');
      const b = await open('t2', 'u2');
      await hub.onModuleDestroy();
      for (const { sink } of [a, b]) {
        expect(sink.text).toContain('event: server-shutdown');
        expect(sink.ended).toBe(true);
      }
      expect(hub.canAccept()).toBe(false);
    });
  });
});
