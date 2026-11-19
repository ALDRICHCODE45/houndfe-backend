/**
 * Unit spec of one SSE connection (unit 8; contract §5.3, §10.1 R5/R6, §12.1):
 * framing, the 15 s heartbeat, JWT expiry, the periodic access re-check, and
 * the backpressure policy (a slow client is dropped with a reason).
 */
import { STREAM_LIMITS } from '../domain/realtime-events';
import type { AccessResult } from './realtime-access';
import { RealtimeStream, type StreamSink } from './realtime-stream';

class FakeSink implements StreamSink {
  chunks: string[] = [];
  ended = false;
  destroyed = false;
  buffered = 0;
  acceptWrites = true;
  private drain: (() => void) | null = null;
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return this.acceptWrites;
  }
  end(chunk?: string): void {
    if (chunk) this.chunks.push(chunk);
    this.ended = true;
  }
  destroy(): void {
    this.destroyed = true;
  }
  get bufferedBytes(): number {
    return this.buffered;
  }
  onDrain(cb: () => void): void {
    this.drain = cb;
  }
  fireDrain(): void {
    this.acceptWrites = true;
    this.drain?.();
  }
  get text(): string {
    return this.chunks.join('');
  }
}

const ABILITY = { can: () => true };
const T0 = Date.parse('2026-11-11T12:00:00.000Z');

function make(
  over: {
    expiresAtMs?: number;
    revalidate?: () => Promise<AccessResult>;
    sink?: FakeSink;
  } = {},
) {
  const sink = over.sink ?? new FakeSink();
  const closed: RealtimeStream[] = [];
  const stream = new RealtimeStream({
    tenantId: 't1',
    userId: 'u1',
    sink,
    ability: ABILITY,
    expiresAtMs: over.expiresAtMs ?? T0 + 15 * 60_000,
    revalidate:
      over.revalidate ??
      (() => Promise.resolve({ ok: true, ability: ABILITY })),
    onClose: (s) => closed.push(s),
  });
  return { stream, sink, closed };
}

describe('RealtimeStream', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: T0 });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts with the retry hint and frames events with their id', () => {
    const { stream, sink } = make();
    stream.start();
    expect(sink.text).toBe(`retry: ${STREAM_LIMITS.retryMs}\n\n`);
    stream.send({ id: 42n, event: 'request.updated', data: { a: 1 } });
    expect(sink.text).toContain(
      'id: 42\nevent: request.updated\ndata: {"a":1}\n\n',
    );
    expect(stream.lastSentId).toBe(42n);
    stream.close();
  });

  it('does not move lastSentId for frames without an id', () => {
    const { stream } = make();
    stream.start();
    stream.send({ id: 7n, event: 'x', data: {} });
    stream.send({ event: 'heartbeat', data: {} });
    expect(stream.lastSentId).toBe(7n);
    stream.close();
  });

  describe('heartbeat (R6, 12.1)', () => {
    it('sends event: heartbeat every 15 s, without id, with the server time', () => {
      const { stream, sink } = make();
      stream.start();
      jest.advanceTimersByTime(15_000);
      const beat = `event: heartbeat\ndata: {"serverTime":"${new Date(T0 + 15_000).toISOString()}"}\n\n`;
      expect(sink.text).toContain(beat);
      expect(sink.text).not.toContain('id: ');
      jest.advanceTimersByTime(30_000);
      expect(sink.text.match(/event: heartbeat/g)).toHaveLength(3);
      stream.close();
    });

    it('stops after close', () => {
      const { stream, sink } = make();
      stream.start();
      stream.close();
      const before = sink.chunks.length;
      jest.advanceTimersByTime(60_000);
      expect(sink.chunks).toHaveLength(before);
    });
  });

  describe('closing', () => {
    it('writes the closing frame, ends the sink and tells the owner once', () => {
      const { stream, sink, closed } = make();
      stream.start();
      stream.close({ event: 'connection-replaced', data: {} });
      stream.close({ event: 'auth-expired', data: {} });
      expect(sink.ended).toBe(true);
      expect(sink.text).toContain('event: connection-replaced');
      expect(sink.text).not.toContain('auth-expired');
      expect(closed).toEqual([stream]);
      expect(stream.send({ event: 'x', data: {} })).toBe(false);
    });

    it('destroys a socket that still holds bytes after the grace period', () => {
      const sink = new FakeSink();
      sink.buffered = 10;
      const { stream } = make({ sink });
      stream.start();
      stream.close({ event: 'slow-consumer', data: {} });
      expect(sink.destroyed).toBe(false);
      jest.advanceTimersByTime(3_000);
      expect(sink.destroyed).toBe(true);
    });
  });

  describe('JWT expiry (5.3)', () => {
    it('sends auth-expired at the token expiry and closes', () => {
      const { stream, sink, closed } = make({ expiresAtMs: T0 + 20_000 });
      stream.start();
      jest.advanceTimersByTime(19_999);
      expect(sink.ended).toBe(false);
      jest.advanceTimersByTime(1);
      expect(sink.text).toContain('event: auth-expired');
      expect(sink.ended).toBe(true);
      expect(closed).toHaveLength(1);
    });

    it('a lifetime beyond the timer limit (~24.8 days) does not fire at once, and still expires on time', () => {
      const day = 24 * 60 * 60_000;
      const { stream, sink } = make({ expiresAtMs: T0 + 30 * day });
      stream.start();
      jest.advanceTimersByTime(1_000);
      expect(sink.text).not.toContain('auth-expired');
      expect(stream.state).not.toBe('closed');
      jest.advanceTimersByTime(30 * day - 1_001);
      expect(stream.state).not.toBe('closed');
      jest.advanceTimersByTime(1);
      expect(sink.text).toContain('event: auth-expired');
      expect(stream.state).toBe('closed');
    });

    it('a token that already expired closes at once', () => {
      const { stream, sink } = make({ expiresAtMs: T0 - 1 });
      stream.start();
      jest.advanceTimersByTime(0);
      expect(sink.text).toContain('event: auth-expired');
      expect(stream.state).toBe('closed');
    });
  });

  describe('periodic access re-check (R5)', () => {
    it('re-checks every 5 minutes and keeps the stream while access holds', async () => {
      const revalidate = jest
        .fn<Promise<AccessResult>, []>()
        .mockResolvedValue({ ok: true, ability: ABILITY });
      const { stream, sink } = make({
        revalidate,
        expiresAtMs: T0 + 60 * 60_000,
      });
      stream.start();
      await jest.advanceTimersByTimeAsync(5 * 60_000);
      expect(revalidate).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(5 * 60_000);
      expect(revalidate).toHaveBeenCalledTimes(2);
      expect(sink.ended).toBe(false);
      stream.close();
    });

    it('adopts the fresh ability of the check', async () => {
      const fresh = { can: () => false };
      const { stream } = make({
        revalidate: () => Promise.resolve({ ok: true, ability: fresh }),
        expiresAtMs: T0 + 60 * 60_000,
      });
      stream.start();
      await jest.advanceTimersByTimeAsync(5 * 60_000);
      expect(stream.ability).toBe(fresh);
      stream.close();
    });

    it.each([
      'USER_INACTIVE',
      'MEMBERSHIP_REMOVED',
      'PERMISSION_REVOKED',
    ] as const)('closes with access-revoked %s', async (reason) => {
      const { stream, sink, closed } = make({
        revalidate: () => Promise.resolve({ ok: false, reason }),
        expiresAtMs: T0 + 60 * 60_000,
      });
      stream.start();
      await jest.advanceTimersByTimeAsync(5 * 60_000);
      expect(sink.text).toContain(
        `event: access-revoked\ndata: {"reason":"${reason}"}`,
      );
      expect(sink.ended).toBe(true);
      expect(closed).toHaveLength(1);
    });

    it('a failing check (database down) does not close the stream', async () => {
      const { stream, sink } = make({
        revalidate: () => Promise.reject(new Error('db down')),
        expiresAtMs: T0 + 60 * 60_000,
      });
      stream.start();
      await jest.advanceTimersByTimeAsync(5 * 60_000);
      expect(sink.ended).toBe(false);
      expect(stream.state).toBe('replaying');
      stream.close();
    });
  });

  describe('backpressure', () => {
    it('drops a client whose buffer grew past the limit, with a reason', () => {
      const sink = new FakeSink();
      const { stream, closed } = make({ sink });
      stream.start();
      sink.buffered = STREAM_LIMITS.maxBufferedBytes + 1;
      expect(stream.send({ id: 1n, event: 'x', data: {} })).toBe(false);
      expect(sink.text).toContain(
        'event: slow-consumer\ndata: {"reason":"BUFFER_FULL"}',
      );
      expect(sink.ended).toBe(true);
      expect(closed).toHaveLength(1);
    });

    it('drops a client blocked longer than the limit, seen at the next heartbeat', () => {
      const sink = new FakeSink();
      const { stream } = make({ sink });
      stream.start();
      sink.acceptWrites = false;
      stream.send({ id: 1n, event: 'x', data: {} });
      expect(stream.state).not.toBe('closed');
      jest.advanceTimersByTime(STREAM_LIMITS.maxBlockedMs + 5_000);
      expect(sink.text).toContain('"reason":"WRITE_BLOCKED"');
      expect(stream.state).toBe('closed');
    });

    it('a client that drains in time is kept', () => {
      const sink = new FakeSink();
      const { stream } = make({ sink });
      stream.start();
      sink.acceptWrites = false;
      stream.send({ id: 1n, event: 'x', data: {} });
      jest.advanceTimersByTime(5_000);
      sink.fireDrain();
      jest.advanceTimersByTime(STREAM_LIMITS.maxBlockedMs * 2);
      expect(sink.text).not.toContain('slow-consumer');
      expect(stream.state).not.toBe('closed');
      stream.close();
    });

    it('drops a stream whose replay buffer overflows (BACKLOG)', () => {
      const { stream, sink } = make();
      stream.start();
      const entry = { prepared: null, event: {} as never };
      for (let i = 0; i < STREAM_LIMITS.maxPendingEvents + 1; i += 1) {
        stream.buffer.push(entry);
      }
      stream.checkBacklog();
      expect(sink.text).toContain('"reason":"BACKLOG"');
      expect(stream.state).toBe('closed');
    });
  });
});
