/**
 * A minimal real SSE client for the integration and perf specs (excluded from
 * the build: `test-support`). Plain `node:http`, so it talks to the real socket
 * of a listening Nest app exactly as a browser's `fetch` would: it sends the
 * headers it is given, reads the chunked body and parses the SSE frames.
 */
import http from 'node:http';

export interface SseMessage {
  id: string | null;
  event: string;
  data: unknown;
  /** `Date.now()` when the frame was parsed (perf spec latency). */
  receivedAt: number;
}

export class SseClient {
  readonly messages: SseMessage[] = [];
  status = 0;
  headers: http.IncomingHttpHeaders = {};
  /** The raw text received, comments and `retry:` lines included. */
  raw = '';
  ended = false;
  private buffer = '';
  private request: http.ClientRequest | null = null;
  private waiters: Array<() => void> = [];
  private done: Promise<void> = Promise.resolve();

  /** Opens the stream; resolves with the response head (status, headers). */
  open(
    baseUrl: string,
    path: string,
    headers: Record<string, string> = {},
  ): Promise<this> {
    const url = new URL(path, baseUrl);
    return new Promise((resolve, reject) => {
      let finish: () => void = () => undefined;
      this.done = new Promise<void>((r) => {
        finish = r;
      });
      this.request = http.get(
        url,
        { headers: { accept: 'text/event-stream', ...headers } },
        (res) => {
          this.status = res.statusCode ?? 0;
          this.headers = res.headers;
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => this.onData(chunk));
          const end = () => {
            this.ended = true;
            this.notify();
            finish();
          };
          res.on('end', end);
          res.on('close', end);
          res.on('error', end);
          resolve(this);
        },
      );
      this.request.on('error', (error) => {
        this.ended = true;
        this.notify();
        finish();
        reject(error);
      });
    });
  }

  /** Last `id:` seen on any message (what a browser would send back). */
  get lastEventId(): string | null {
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const id = this.messages[i].id;
      if (id !== null) return id;
    }
    return null;
  }

  of(event: string): SseMessage[] {
    return this.messages.filter((m) => m.event === event);
  }

  /** Event names in order, heartbeats excluded. */
  get names(): string[] {
    return this.messages.map((m) => m.event).filter((n) => n !== 'heartbeat');
  }

  async waitFor(
    predicate: (messages: SseMessage[]) => boolean,
    timeoutMs = 5_000,
    what = 'condition',
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.messages)) {
      if (this.ended) {
        if (predicate(this.messages)) return;
        throw new Error(`stream ended before ${what}: ${this.names.join(',')}`);
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(`timeout waiting for ${what}: ${this.names.join(',')}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 100));
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  waitForEvent(event: string, count = 1, timeoutMs = 5_000): Promise<void> {
    return this.waitFor(
      (messages) => messages.filter((m) => m.event === event).length >= count,
      timeoutMs,
      `${count} x ${event}`,
    );
  }

  /** Resolves when the server (or `close`) ended the response. */
  async whenEnded(timeoutMs = 5_000): Promise<void> {
    await Promise.race([
      this.done,
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error('stream did not end')),
          timeoutMs,
        ).unref(),
      ),
    ]);
  }

  /** Client-side disconnect, like a closed tab. */
  close(): void {
    this.request?.destroy();
    this.ended = true;
    this.notify();
  }

  private onData(chunk: string): void {
    this.raw += chunk;
    this.buffer += chunk;
    for (;;) {
      const at = this.buffer.indexOf('\n\n');
      if (at < 0) break;
      const block = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 2);
      this.parse(block);
    }
    this.notify();
  }

  private parse(block: string): void {
    let id: string | null = null;
    let event = 'message';
    const data: string[] = [];
    let hasField = false;
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'id') id = value;
      else if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
      else continue;
      hasField = true;
    }
    if (!hasField) return; // `retry:` only
    const text = data.join('\n');
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep the text */
    }
    this.messages.push({ id, event, data: parsed, receivedAt: Date.now() });
  }

  private notify(): void {
    const waiters = this.waiters.splice(0);
    for (const wake of waiters) wake();
  }
}
