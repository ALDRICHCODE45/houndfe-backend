/**
 * Unit spec of the HTTP edge of the stream (unit 8; contract §5.3, §12.1): what
 * the client sees when the replica cannot serve realtime. The hub is a double
 * with controllable promises; the response is a recorder.
 */
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import {
  RealtimeUnavailableError,
  type RealtimeHub,
} from '../application/realtime-hub.service';
import { RealtimeController } from './realtime.controller';

class FakeRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  flushed = false;
  ended = false;
  private handlers = new Map<string, () => void>();
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  setHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  flushHeaders() {
    this.flushed = true;
  }
  on(event: string, handler: () => void) {
    this.handlers.set(event, handler);
  }
  once() {}
  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }
  end(chunk?: string) {
    if (chunk) this.chunks.push(chunk);
    this.ended = true;
  }
  destroy() {}
  get writableLength() {
    return 0;
  }
  emit(event: string) {
    this.handlers.get(event)?.();
  }
}

const req = {
  user: { tenantId: 't1', userId: 'u1' },
  ability: { can: () => true } as unknown as AppAbility,
  headers: {},
  socket: { setNoDelay() {}, setKeepAlive() {}, setTimeout() {} },
} as unknown as Parameters<RealtimeController['stream']>[0];

function build(hub: Partial<Record<keyof RealtimeHub, jest.Mock>>) {
  const full = {
    canAccept: jest.fn(() => true),
    ensureReady: jest.fn(() => Promise.resolve()),
    connect: jest.fn(() => Promise.resolve({ dispose: jest.fn() })),
    ...hub,
  };
  const res = new FakeRes();
  const controller = new RealtimeController(full as unknown as RealtimeHub);
  const run = () =>
    controller.stream(req, res as unknown as Response, undefined, undefined);
  return { full, res, run };
}

describe('RealtimeController', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('answers 503 REALTIME_UNAVAILABLE with Retry-After BEFORE any SSE header when the LISTEN start failed', async () => {
    const { full, res, run } = build({
      ensureReady: jest.fn(() =>
        Promise.reject(new RealtimeUnavailableError()),
      ),
    });
    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      statusCode: 503,
      code: 'REALTIME_UNAVAILABLE',
      message: expect.any(String) as string,
    });
    expect(res.headers['Retry-After']).toBe('5');
    expect(res.flushed).toBe(false);
    expect(res.headers['Content-Type']).toBeUndefined();
    expect(full.connect).not.toHaveBeenCalled();
  });

  it('after the headers are out, a hub failure emits server-unavailable and closes', async () => {
    const { res, run } = build({
      connect: jest.fn(() => Promise.reject(new RealtimeUnavailableError())),
    });
    await run();
    expect(res.flushed).toBe(true);
    expect(res.chunks.join('')).toContain('event: server-unavailable');
    expect(res.chunks.join('')).toContain('"reason":"REALTIME_UNAVAILABLE"');
    expect(res.ended).toBe(true);
  });

  it('an unexpected hub error after the headers also ends with server-unavailable, never an empty 200', async () => {
    const { res, run } = build({
      connect: jest.fn(() => Promise.reject(new Error('boom'))),
    });
    await run();
    expect(res.chunks.join('')).toContain('event: server-unavailable');
    expect(res.ended).toBe(true);
  });

  it('serves normally once the hub is ready', async () => {
    const dispose = jest.fn();
    const { full, res, run } = build({
      connect: jest.fn(() => Promise.resolve({ dispose })),
    });
    await run();
    expect(res.statusCode).toBe(200);
    expect(res.flushed).toBe(true);
    expect(full.connect).toHaveBeenCalledTimes(1);
    expect(res.ended).toBe(false);
    res.emit('close');
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
