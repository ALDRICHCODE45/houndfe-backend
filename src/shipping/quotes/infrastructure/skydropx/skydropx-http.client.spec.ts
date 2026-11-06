import {
  type FetchLike,
  type SkydropxClock,
  SkydropxError,
  SkydropxHttpClient,
  SkydropxRateLimiter,
} from './skydropx-http.client';

/** Manual clock: sleeping advances time instantly. */
class FakeClock implements SkydropxClock {
  t = 1_000_000;
  sleeps: number[] = [];
  now(): number {
    return this.t;
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    this.sleeps.push(ms);
    this.t += ms;
    return Promise.resolve();
  }
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function parseBody(init: RequestInit): unknown {
  if (typeof init.body !== 'string') return undefined;
  const type = (init.headers as Record<string, string>)['Content-Type'];
  return type === 'application/x-www-form-urlencoded'
    ? Object.fromEntries(new URLSearchParams(init.body))
    : JSON.parse(init.body);
}

function fakeFetch(
  handler: (call: Call, index: number) => Response | Promise<Response>,
): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: parseBody(init),
    };
    calls.push(call);
    return Promise.resolve(handler(call, calls.length - 1));
  };
  return { fetch, calls };
}

const isToken = (call: Call) => call.url.endsWith('/api/v1/oauth/token');

function client(fetch: FetchLike, clock = new FakeClock()) {
  return new SkydropxHttpClient({
    baseUrl: 'https://api.example.test/',
    clientId: 'id-123',
    clientSecret: 'secret-456',
    requestTimeoutMs: 5000,
    fetch,
    clock,
    limiter: new SkydropxRateLimiter(0, clock),
  });
}

describe('SkydropxHttpClient — OAuth token', () => {
  it('requests a client_credentials token once and reuses it until shortly before expiry', async () => {
    const clock = new FakeClock();
    let tokens = 0;
    const { fetch, calls } = fakeFetch((call) =>
      isToken(call)
        ? json(200, { access_token: `tok-${++tokens}`, expires_in: 7200 })
        : json(200, { ok: true }),
    );
    const http = client(fetch, clock);

    await http.request('GET', '/api/v1/quotations/q1');
    clock.t += 60 * 60 * 1000; // 1 h later: still cached
    await http.request('GET', '/api/v1/quotations/q1');

    const tokenCalls = calls.filter(isToken);
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]).toMatchObject({
      url: 'https://api.example.test/api/v1/oauth/token',
      method: 'POST',
      body: {
        grant_type: 'client_credentials',
        client_id: 'id-123',
        client_secret: 'secret-456',
      },
    });
    // OAuth 2 token endpoint: a form body, not JSON (chatbot reference).
    expect(tokenCalls[0].headers['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    const apiCalls = calls.filter((c) => !isToken(c));
    expect(apiCalls.map((c) => c.headers.Authorization)).toEqual([
      'Bearer tok-1',
      'Bearer tok-1',
    ]);

    // 1 h 56 min after issue: inside the refresh margin → new token.
    clock.t += 56 * 60 * 1000;
    await http.request('GET', '/api/v1/quotations/q1');
    expect(calls.filter(isToken)).toHaveLength(2);
    expect(calls.at(-1)?.headers.Authorization).toBe('Bearer tok-2');
  });

  it('refreshes single-flight: concurrent requests share one token call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { fetch, calls } = fakeFetch(async (call) => {
      if (isToken(call)) {
        await gate;
        return json(200, { access_token: 'tok', expires_in: 7200 });
      }
      return json(200, {});
    });
    const http = client(fetch);

    const all = Promise.all([
      http.request('GET', '/a'),
      http.request('GET', '/b'),
      http.request('GET', '/c'),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await all;

    expect(calls.filter(isToken)).toHaveLength(1);
    expect(calls.filter((c) => !isToken(c))).toHaveLength(3);
  });

  it('on 401 drops the token, refreshes once and retries the request once', async () => {
    let tokens = 0;
    const { fetch, calls } = fakeFetch((call) => {
      if (isToken(call)) {
        return json(200, { access_token: `tok-${++tokens}`, expires_in: 7200 });
      }
      return call.headers.Authorization === 'Bearer tok-1'
        ? json(401, { error: 'invalid_token' })
        : json(200, { id: 'q1' });
    });
    const http = client(fetch);

    await expect(http.request('GET', '/x')).resolves.toEqual({
      status: 200,
      body: { id: 'q1' },
    });
    expect(
      calls.map((c) => (isToken(c) ? 'token' : c.headers.Authorization)),
    ).toEqual(['token', 'Bearer tok-1', 'token', 'Bearer tok-2']);
  });

  it('gives up after the single retry when the API keeps answering 401', async () => {
    let tokens = 0;
    const { fetch, calls } = fakeFetch((call) =>
      isToken(call)
        ? json(200, { access_token: `tok-${++tokens}`, expires_in: 7200 })
        : json(401, {}),
    );
    const http = client(fetch);

    await expect(http.request('GET', '/x')).rejects.toMatchObject({
      name: 'SkydropxError',
      status: 401,
    });
    expect(calls.filter((c) => !isToken(c))).toHaveLength(2);
    expect(calls.filter(isToken)).toHaveLength(2);
  });

  it('fails without leaking credentials when the token endpoint rejects them', async () => {
    const { fetch } = fakeFetch(() =>
      json(401, {
        error: 'invalid_client',
        error_description: 'secret-456 is wrong',
      }),
    );
    const http = client(fetch);

    const error = await http.request('GET', '/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SkydropxError);
    expect((error as SkydropxError).status).toBe(401);
    expect(String((error as Error).message)).not.toMatch(
      /secret|id-123|invalid_client/,
    );
  });

  it('rejects a token response without access_token', async () => {
    const { fetch } = fakeFetch(() => json(200, { token_type: 'Bearer' }));
    await expect(client(fetch).request('GET', '/x')).rejects.toBeInstanceOf(
      SkydropxError,
    );
  });

  it('a failed refresh is not cached: the next request asks again', async () => {
    let attempt = 0;
    const { fetch, calls } = fakeFetch((call) => {
      if (isToken(call)) {
        attempt += 1;
        return attempt === 1
          ? json(500, {})
          : json(200, { access_token: 'tok', expires_in: 7200 });
      }
      return json(200, {});
    });
    const http = client(fetch);

    await expect(http.request('GET', '/x')).rejects.toBeInstanceOf(
      SkydropxError,
    );
    await expect(http.request('GET', '/x')).resolves.toMatchObject({
      status: 200,
    });
    expect(calls.filter(isToken)).toHaveLength(2);
  });

  it('returns non-2xx API answers as errors with their status, never the body', async () => {
    const { fetch } = fakeFetch((call) =>
      isToken(call)
        ? json(200, { access_token: 'tok', expires_in: 7200 })
        : json(422, { errors: ['address 64000 Centro is invalid'] }),
    );
    const error = await client(fetch)
      .request('POST', '/api/v1/quotations', { a: 1 })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'SkydropxError', status: 422 });
    expect(String((error as Error).message)).not.toContain('64000');
  });

  it('sends JSON bodies with the bearer token', async () => {
    const { fetch, calls } = fakeFetch((call) =>
      isToken(call)
        ? json(200, { access_token: 'tok', expires_in: 7200 })
        : json(201, { id: 'q1' }),
    );
    await client(fetch).request('POST', '/api/v1/quotations', {
      quotation: {},
    });
    const post = calls.find((c) => !isToken(c));
    expect(post).toMatchObject({
      url: 'https://api.example.test/api/v1/quotations',
      method: 'POST',
      body: { quotation: {} },
    });
    expect(post?.headers['Content-Type']).toBe('application/json');
  });

  it('stops before any call when the signal is already aborted', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, {}));
    const controller = new AbortController();
    controller.abort();
    await expect(
      client(fetch).request('GET', '/x', undefined, controller.signal),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('SkydropxHttpClient — per-call timeout', () => {
  /** Records the timeout of every HTTP call, in call order. */
  function timedClient(
    handler: (call: Call, clock: FakeClock) => Response,
    requestTimeoutMs = 5000,
  ) {
    const clock = new FakeClock();
    const timeouts: number[] = [];
    const { fetch, calls } = fakeFetch((call) => handler(call, clock));
    const http = new SkydropxHttpClient({
      baseUrl: 'https://api.example.test',
      clientId: 'id',
      clientSecret: 'secret',
      requestTimeoutMs,
      fetch,
      clock,
      limiter: new SkydropxRateLimiter(0, clock),
      timeoutSignal: (ms) => {
        timeouts.push(ms);
        return new AbortController().signal;
      },
    });
    return { http, calls, timeouts, clock };
  }

  it('caps every call at SKYDROPX_REQUEST_TIMEOUT_MS even with a longer deadline', async () => {
    const { http, timeouts } = timedClient((call) =>
      isToken(call)
        ? json(200, { access_token: 'tok', expires_in: 7200 })
        : json(200, {}),
    );

    await http.request('POST', '/api/v1/quotations', {}, undefined, 11_500);

    expect(timeouts).toEqual([5000, 5000]);
  });

  it('uses the remaining deadline when it is shorter, the 401 retry included', async () => {
    let tokens = 0;
    const { http, timeouts } = timedClient((call, clock) => {
      clock.t += 400; // every answer takes 400 ms
      if (isToken(call)) {
        return json(200, { access_token: `tok-${++tokens}`, expires_in: 7200 });
      }
      return call.headers.Authorization === 'Bearer tok-1'
        ? json(401, {})
        : json(200, {});
    });

    await http.request(
      'GET',
      '/api/v1/quotations/q1',
      undefined,
      undefined,
      3000,
    );

    // Token calls keep their own bound (the refresh is shared); the GET
    // gets 3000 − 400 and its 401 retry what is left after the refresh.
    expect(timeouts).toEqual([5000, 2600, 5000, 1800]);
  });

  it('fails without calling when the deadline is already spent', async () => {
    const { http, calls } = timedClient((call, clock) => {
      clock.t += 1000;
      return isToken(call)
        ? json(200, { access_token: 'tok', expires_in: 7200 })
        : json(200, {});
    });

    await expect(
      http.request('GET', '/api/v1/quotations/q1', undefined, undefined, 1000),
    ).rejects.toMatchObject({ name: 'SkydropxError', status: null });
    expect(calls.filter((c) => !isToken(c))).toHaveLength(0);
  });
});

describe('SkydropxRateLimiter', () => {
  it('spaces request starts by the minimum interval (2 req/s → 500 ms)', async () => {
    const clock = new FakeClock();
    const limiter = new SkydropxRateLimiter(500, clock);
    const starts: number[] = [];

    for (let i = 0; i < 4; i += 1) {
      await limiter.acquire();
      starts.push(clock.now());
    }

    expect(starts.map((t) => t - starts[0])).toEqual([0, 500, 1000, 1500]);
  });

  it('does not wait when the previous request was long enough ago', async () => {
    const clock = new FakeClock();
    const limiter = new SkydropxRateLimiter(500, clock);
    await limiter.acquire();
    clock.t += 2000;
    await limiter.acquire();
    expect(clock.sleeps).toEqual([]);
  });

  it('reserves slots for concurrent callers in order', async () => {
    const clock = new FakeClock();
    const waits: number[] = [];
    clock.sleep = (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    };
    const limiter = new SkydropxRateLimiter(500, clock);
    await Promise.all([
      limiter.acquire(),
      limiter.acquire(),
      limiter.acquire(),
    ]);
    expect(waits).toEqual([500, 1000]);
  });

  it('is applied to every HTTP call, token included', async () => {
    const clock = new FakeClock();
    const { fetch } = fakeFetch((call) =>
      isToken(call)
        ? json(200, { access_token: 'tok', expires_in: 7200 })
        : json(200, {}),
    );
    const http = new SkydropxHttpClient({
      baseUrl: 'https://api.example.test',
      clientId: 'id',
      clientSecret: 'secret',
      requestTimeoutMs: 5000,
      fetch,
      clock,
      limiter: new SkydropxRateLimiter(500, clock),
    });
    await http.request('GET', '/a');
    await http.request('GET', '/b');
    // token at t0, /a waits 500, /b waits 500.
    expect(clock.sleeps).toEqual([500, 500]);
  });
});
