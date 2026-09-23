/**
 * InngestService — NestJS-side wrapper around the Inngest client.
 *
 * Owns the integration boundary so the rest of the codebase never imports
 * `inngest` directly. Three responsibilities:
 *
 *   1. **Client construction.** Reads `INNGEST_EVENT_KEY` from
 *      `ConfigService`. Joi (D.4) makes it required in staging/production,
 *      so a missing key fails fast at boot — never at first `send`. In
 *      dev/test the key is optional because the Inngest Dev Server
 *      accepts unsigned events.
 *
 *      **Fail-closed posture on `INNGEST_DEV` (D-hardening).** The
 *      Inngest SDK derives its `mode` (cloud vs dev) from a priority
 *      chain: `options.isDev` → `INNGEST_DEV` env var → explicit URL →
 *      default cloud. Dev mode makes `serve()` accept UNSIGNED requests,
 *      which is a fatal bypass on `/api/inngest` — the endpoint has no
 *      JWT guard and relies entirely on the SDK's signature check.
 *      Joi (D.4 + D-hardening) already rejects a truthy `INNGEST_DEV`
 *      when `NODE_ENV` is staging/production. We additionally pin
 *      `isDev: false` at construction time in those environments so an
 *      `INNGEST_DEV=1` that somehow slips past the schema cannot flip
 *      the client to dev mode. In dev/test we leave `isDev` unset so the
 *      SDK falls back to its default behavior (reads INNGEST_DEV from
 *      env — needed for the local Dev Server flow).
 *
 *   2. **`send(name, data, idempotencyKey)` — the domain port.** The
 *      dedicated low-stock outbox dispatcher (Slice F) calls this to
 *      enqueue a crossing into Inngest. The idempotency key is passed as
 *      Inngest's `id` so the SDK dedupes by it: a poller replay of the
 *      same row, or an Inngest retry of the same event, collapse to ONE
 *      email (finding #5).
 *
 *   3. **`getFunctions()` accessor** that the Inngest serve handler
 *      (D.3) hands to `serve({ functions })`. Empty in D; E/F populate it
 *      with `inngest.createFunction(...)` closures built over injected
 *      `NotificationConfigRepository`, `MailerPort`, and
 *      `TenantRunnerService` (per design.md "Inngest + Resend Wiring").
 *
 * Defensive copy on `getFunctions()` — callers MUST NOT be able to mutate
 * the internal registry and accidentally register functions at runtime.
 *
 * Spec: design.md "Inngest + Resend Wiring" (`InngestService` paragraph).
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Inngest } from 'inngest';

const INNGEST_APP_ID = 'houndfe-backend';
const DEPLOYED_NODE_ENVS = new Set(['staging', 'production']);

@Injectable()
export class InngestService {
  private readonly client: Inngest;
  private readonly eventKey: string | undefined;
  // The Inngest SDK's `InngestFunction` type is generic with required
  // parameters we can't satisfy here without referencing the SDK's
  // internal type machinery (each registered function has its own
  // concrete trigger / handler types). For our purposes, `getFunctions()`
  // hands the array to `serve({ functions })` — the SDK accepts any
  // shape that satisfies `InngestFunction.Like`. We type the internal
  // registry as `unknown[]` and let `getFunctions()` re-cast it for the
  // SDK contract.
  private readonly functions: unknown[] = [];

  constructor(configService: ConfigService) {
    // eventKey is optional at the SDK level — the Joi schema (D.4) makes
    // it required in staging/production, so the app never boots with a
    // missing key in those environments.
    const key = configService.get<string>('INNGEST_EVENT_KEY');
    const nodeEnv = configService.get<string>('NODE_ENV');

    this.eventKey = key;

    // Pin cloud mode in deployed envs — see file header. isDev:false
    // takes priority over INNGEST_DEV in the SDK's mode-resolution chain,
    // so a misconfigured env var cannot demote the client to dev (which
    // would silently disable signature verification on /api/inngest).
    const isDev = DEPLOYED_NODE_ENVS.has(nodeEnv ?? '') ? false : undefined;

    this.client = new Inngest({
      id: INNGEST_APP_ID,
      ...(key ? { eventKey: key } : {}),
      ...(isDev === undefined ? {} : { isDev }),
    });
  }

  /**
   * Send an event into Inngest with a deterministic idempotency key
   * (typically `${tenantId}:${productId}:${variantKey}:${alertEpoch}`
   * per design.md finding #5). Returns the SDK response verbatim; the
   * dedicated outbox dispatcher (Slice F) interprets it as resolve /
   * reject for marking PUBLISHED vs PENDING+retry.
   */
  send(
    name: string,
    data: unknown,
    idempotencyKey: string,
  ): Promise<{ ids: string[] }> {
    return this.client.send({
      name,
      data: data as Record<string, unknown>,
      id: idempotencyKey,
    });
  }

  /**
   * The list of `InngestFunction` registrations to hand to `serve()`.
   * Returns a defensive copy so callers cannot mutate the internal
   * registry. Empty in D; E/F populate by calling `registerFunctions`
   * (see below) at `OnModuleInit` time. The InngestController hands
   * the array straight through to `serve({ functions })`.
   *
   * The return type is `unknown[]` because the SDK's `InngestFunction`
   * is a generic whose concrete shape depends on the function's trigger
   * and handler — the SDK's `serve({ functions })` accepts any
   * `InngestFunction.Like[]`. Slice F's `buildLowStockFunctions` returns
   * an `unknown[]` it built from the same SDK; the cast happens at the
   * call site (the controller).
   */
  getFunctions(): unknown[] {
    return [...this.functions];
  }

  /**
   * Register one or more `InngestFunction` closures built via the
   * client's `createFunction(...)`. Called by feature modules (e.g.
   * `StockAlertsModule` via its `OnModuleInit` hook) at boot time.
   * Throws if any entry duplicates an already-registered `id` —
   * duplicate registration would silently overwrite the handler and
   * create two functions racing for the same trigger.
   *
   * **Atomicity (pca-5c).** The batch is validated in full BEFORE
   * `this.functions` is touched, so a duplicate at the end of a batch
   * cannot leave the earlier entries half-registered.
   *
   * **Fail-closed (pca-5c).** An entry whose id cannot be resolved is
   * rejected rather than accepted as “anonymous”: an unresolvable id is
   * indistinguishable from a duplicate, and silently skipping it is how
   * the guard previously became a no-op for every real SDK function
   * (see `extractInngestId`). Production functions always carry a
   * required `opts.id`, so this only rejects malformed/fake entries.
   *
   * The defnsive-copy rule on `getFunctions()` only protects the
   * REGISTRY from external mutation; this method is the SOLE
   * owner of registration and is the only place that mutates
   * `this.functions`. Module-load happens once; runtime calls
   * are not expected after the InngestController handler is wired.
   *
   * Spec: design.md "Inngest + Resend Wiring" — `InngestService`
   * paragraph + Module placement.
   */
  registerFunctions(defs: unknown[]): void {
    const registeredIds = new Set<string>();
    for (const existing of this.functions) {
      const id = extractInngestId(existing);
      if (id) registeredIds.add(id);
    }

    // Pass 1 — resolve every id (no mutation). Pass 2 — reject the whole
    // batch on the first duplicate, whether it collides with the existing
    // registry or with an earlier entry of the same batch.
    const pendingIds = defs.map((def, index) => {
      const id = extractInngestId(def);
      if (id === null) {
        throw new Error(
          `InngestService.registerFunctions: could not resolve a function id at index ${index}. ` +
            'Refusing to register an unidentified function — the duplicate-id guard cannot protect it.',
        );
      }
      return { id, index };
    });

    const seenInBatch = new Set<string>();
    for (const { id, index } of pendingIds) {
      if (registeredIds.has(id) || seenInBatch.has(id)) {
        throw new Error(
          `InngestService.registerFunctions: duplicate function id "${id}" (batch index ${index}).`,
        );
      }
      seenInBatch.add(id);
    }

    this.functions.push(...defs);
  }

  /**
   * The Inngest client instance — the InngestController uses it to wire
   * `serve({ client })`.
   */
  getClient(): Inngest {
    return this.client;
  }

  /** The Inngest app id used at client construction (for diagnostics). */
  getClientId(): string {
    return this.client.id;
  }

  /** The configured INNGEST_EVENT_KEY (or undefined in non-prod dev mode). */
  getEventKey(): string | undefined {
    return this.eventKey;
  }
}

/**
 * Best-effort extraction of the `id` field from an `InngestFunction`
 * closure. Four shapes are tolerated, in priority order:
 *
 *   1. A plain string `id` (legacy fakes / older SDK surfaces).
 *   2. `id()` as a METHOD — the real Inngest **v4** `InngestFunction`
 *      exposes the id as a prototype method and `serve()` routes on its
 *      return value. Reading `fn.id` as a string (the pre-pca-5c bug)
 *      returned `undefined` for every real function, so the duplicate
 *      guard silently accepted duplicates. `opts.id` is the raw value
 *      behind it; the method is preferred because that is what the SDK
 *      itself serializes (`id()` accepts an optional prefix, and calling
 *      it bare yields the bare id).
 *   3. `opts.id` — the raw v4 options surface (covers SDK versions that
 *      drop the method or move it behind a subclass).
 *   4. `config.id` — a wrapped-config shape some adapters expose.
 *
 * A `null` return means “no usable id”. `registerFunctions` treats that
 * as a fail-closed rejection: an unresolvable id cannot be
 * duplicate-checked, and silently accepting it is exactly how the guard
 * stopped protecting production functions.
 */
function extractInngestId(def: unknown): string | null {
  if (!def || typeof def !== 'object') return null;
  const d = def as Record<string, unknown>;

  const direct = readFunctionId(d.id);
  if (direct) return direct;

  if (typeof d.id === 'function') {
    try {
      // `id()` is a prototype method on the real v4 `InngestFunction`.
      const viaMethod = readFunctionId(
        (d.id as (prefix?: string) => unknown).call(def),
      );
      if (viaMethod) return viaMethod;
    } catch {
      // A throwing `id()` is not a usable id source — fall through to
      // `opts.id` / `config.id` instead of crashing the boot.
    }
  }

  const opts = d.opts;
  if (opts && typeof opts === 'object') {
    const viaOpts = readFunctionId((opts as Record<string, unknown>).id);
    if (viaOpts) return viaOpts;
  }

  const cfg = d.config;
  if (cfg && typeof cfg === 'object') {
    const viaConfig = readFunctionId((cfg as Record<string, unknown>).id);
    if (viaConfig) return viaConfig;
  }

  return null;
}

/** Only a non-empty string is a usable function id. */
function readFunctionId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
