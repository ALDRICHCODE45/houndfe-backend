/**
 * shipping-zones / T6 (S6) — HTTP client for Skydropx API Pro.
 *
 * - OAuth client_credentials (`POST /api/v1/oauth/token`, form-urlencoded
 *   body as OAuth 2 specifies). The token (2 h) is cached until shortly before it expires; concurrent callers share one
 *   refresh (single flight), and a failed refresh is not cached.
 * - A request answered 401 drops that token, refreshes and is retried once.
 * - Every call, the token one included, goes through a client-side limiter:
 *   Skydropx allows 2 requests per second.
 * - Every call is bounded by `requestTimeoutMs` and, for a request given a
 *   `timeoutMs`, by what is left of it (the 401 retry included). The shared
 *   token call keeps `requestTimeoutMs` alone: it serves every waiter.
 *
 * Errors never carry response bodies, credentials or tokens: Skydropx can
 * echo addresses back, and carrier errors may reach logs.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface SkydropxClock {
  now(): number;
  /** Resolves after `ms`; rejects as soon as `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('The operation was aborted');
}

export const systemClock: SkydropxClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError(signal));
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError(signal as AbortSignal));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

export class SkydropxError extends Error {
  override readonly name = 'SkydropxError';
  /** HTTP status Skydropx answered, or null (deadline, malformed answer). */
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

/** Spaces request starts at least `minIntervalMs` apart (2 req/s → 500). */
export class SkydropxRateLimiter {
  private nextSlot = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly minIntervalMs: number,
    private readonly clock: SkydropxClock = systemClock,
  ) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError(signal);
    const now = this.clock.now();
    // Reserve the slot synchronously so concurrent callers queue in order.
    const at = Math.max(now, this.nextSlot);
    this.nextSlot = at + this.minIntervalMs;
    if (at > now) await this.clock.sleep(at - now, signal);
  }
}

export interface SkydropxResponse {
  status: number;
  body: unknown;
}

/** What the carrier needs from the client; tests replace it. */
export interface SkydropxRequester {
  request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<SkydropxResponse>;
}

export interface SkydropxHttpClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Upper bound of one HTTP call. */
  requestTimeoutMs: number;
  fetch?: FetchLike;
  clock?: SkydropxClock;
  limiter?: SkydropxRateLimiter;
  /** Abort signal of one call; tests replace it to observe the timeouts. */
  timeoutSignal?: (ms: number) => AbortSignal;
}

interface CachedToken {
  value: string;
  refreshAt: number;
}

const TOKEN_PATH = '/api/v1/oauth/token';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** Used when the token answer has no usable `expires_in`. */
const FALLBACK_TOKEN_TTL_S = 3600;

/** Waits for a shared promise, but lets one caller give up on its own abort. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error as Error);
      },
    );
  });
}

export class SkydropxHttpClient implements SkydropxRequester {
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;
  private readonly clock: SkydropxClock;
  private readonly limiter: SkydropxRateLimiter;
  private readonly timeoutSignal: (ms: number) => AbortSignal;
  private token: CachedToken | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(private readonly options: SkydropxHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.clock = options.clock ?? systemClock;
    this.limiter = options.limiter ?? new SkydropxRateLimiter(500, this.clock);
    this.timeoutSignal =
      options.timeoutSignal ?? ((ms) => AbortSignal.timeout(ms));
  }

  async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<SkydropxResponse> {
    if (signal?.aborted) throw abortError(signal);
    const deadlineAt =
      timeoutMs === undefined
        ? Number.POSITIVE_INFINITY
        : this.clock.now() + timeoutMs;
    let token = await this.accessToken(signal);
    let response = await this.call(
      method,
      path,
      { json: body },
      token,
      signal,
      deadlineAt,
    );
    if (response.status === 401) {
      this.dropToken(token);
      token = await this.accessToken(signal);
      response = await this.call(
        method,
        path,
        { json: body },
        token,
        signal,
        deadlineAt,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new SkydropxError(
        `Skydropx ${method} ${path} answered ${response.status}`,
        response.status,
      );
    }
    return response;
  }

  private accessToken(signal?: AbortSignal): Promise<string> {
    const cached = this.token;
    if (cached && this.clock.now() < cached.refreshAt) {
      return Promise.resolve(cached.value);
    }
    // The shared refresh is not bound to one caller's signal: a caller that
    // gives up must not fail the others.
    this.refreshing ??= this.requestToken().finally(() => {
      this.refreshing = null;
    });
    return abortable(this.refreshing, signal);
  }

  private dropToken(value: string): void {
    if (this.token?.value === value) this.token = null;
  }

  private async requestToken(): Promise<string> {
    const issuedAt = this.clock.now();
    const response = await this.call(
      'POST',
      TOKEN_PATH,
      {
        form: new URLSearchParams({
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
          grant_type: 'client_credentials',
        }),
      },
      null,
      undefined,
      Number.POSITIVE_INFINITY,
    );
    if (response.status < 200 || response.status >= 300) {
      throw new SkydropxError(
        `Skydropx token request answered ${response.status}`,
        response.status,
      );
    }
    const body = response.body as {
      access_token?: unknown;
      expires_in?: unknown;
    } | null;
    const value = body?.access_token;
    if (typeof value !== 'string' || value === '') {
      throw new SkydropxError(
        'Skydropx token answer has no access_token',
        null,
      );
    }
    const expiresIn = body?.expires_in;
    const ttlMs =
      (typeof expiresIn === 'number' &&
      Number.isFinite(expiresIn) &&
      expiresIn > 0
        ? expiresIn
        : FALLBACK_TOKEN_TTL_S) * 1000;
    this.token = {
      value,
      refreshAt: issuedAt + ttlMs - Math.min(REFRESH_MARGIN_MS, ttlMs / 2),
    };
    return value;
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body: { json?: unknown; form?: URLSearchParams },
    token: string | null,
    signal: AbortSignal | undefined,
    deadlineAt: number,
  ): Promise<SkydropxResponse> {
    await this.limiter.acquire(signal);
    // Measured after the limiter wait: the wait spends the deadline too.
    const timeoutMs = Math.min(
      this.options.requestTimeoutMs,
      deadlineAt - this.clock.now(),
    );
    if (timeoutMs <= 0) {
      throw new SkydropxError(
        `Skydropx ${method} ${path} not sent: deadline reached`,
        null,
      );
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload: string | undefined;
    if (body.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      payload = body.form.toString();
    } else if (body.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body.json);
    }
    const timeout = this.timeoutSignal(timeoutMs);
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: payload,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (response.ok) {
          throw new SkydropxError(
            `Skydropx ${method} ${path} answered malformed JSON`,
            response.status,
          );
        }
      }
    }
    return { status: response.status, body: parsed };
  }
}
