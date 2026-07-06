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

    this.eventKey = key;
    this.client = new Inngest({
      id: INNGEST_APP_ID,
      ...(key ? { eventKey: key } : {}),
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
   * registry. Empty in D; E/F add `createFunction` closures via
   * follow-up slices (mirrors how the design wires
   * `NotificationConfigRepository`, `MailerPort`, `TenantRunnerService`).
   *
   * The return type is `unknown[]` because the SDK's `InngestFunction`
   * is a generic whose concrete shape depends on the function's trigger
   * and handler — the SDK's `serve({ functions })` accepts any
   * `InngestFunction.Like[]`, and the InngestController hands the
   * array straight through. E/F will populate this list with real
   * `createFunction(...)` calls; the cast happens at the call site.
   */
  getFunctions(): unknown[] {
    return [...this.functions];
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