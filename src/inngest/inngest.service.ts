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
    const registeredIds = new Set(
      (this.functions as Array<{ id?: unknown } | undefined | null>)
        .map((f) => extractInngestId(f))
        .filter((id): id is string => Boolean(id)),
    );
    for (const def of defs) {
      const id = extractInngestId(def);
      if (id && registeredIds.has(id)) {
        throw new Error(
          `InngestService.registerFunctions: duplicate function id "${id}".`,
        );
      }
      registeredIds.add(id ?? `anonymous-${registeredIds.size}`);
      this.functions.push(def);
    }
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
 * closure. The SDK stores it as a property on the registered object;
 * we tolerate both shapes (top-level `id` and a wrapped `config.id`)
 * because different SDK versions expose different surfaces. A `null`
 * return disables duplicate-id checking for that entry — fine for
 * tests and ad-hoc fakes; production functions MUST supply an id.
 */
function extractInngestId(def: unknown): string | null {
  if (!def || typeof def !== 'object') return null;
  const d = def as Record<string, unknown>;
  if (typeof d.id === 'string') return d.id;
  const cfg = d.config;
  if (
    cfg &&
    typeof cfg === 'object' &&
    typeof (cfg as Record<string, unknown>).id === 'string'
  ) {
    return (cfg as Record<string, unknown>).id as string;
  }
  return null;
}