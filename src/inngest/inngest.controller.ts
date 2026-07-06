/**
 * InngestController — exposes the Inngest `serve()` endpoint at
 * `/api/inngest`.
 *
 * **Security model (design.md "Inngest serve endpoint auth" — CRITICAL).**
 *
 *   - The controller has NO `@UseGuards(...)` decorator. There is no
 *     global `APP_GUARD` (the only JWT guard is the per-controller
 *     `JwtAuthGuard` opted into by protected routes). So
 *     `/api/inngest` is JWT-EXCLUDED.
 *   - The ONLY authentication gate on this endpoint is Inngest's own
 *     signature verification, which `serve({ signingKey })` performs
 *     internally — but ONLY while the SDK client is in CLOUD mode.
 *     Unsigned requests are rejected with 401 by the SDK in cloud
 *     mode; in DEV mode they are accepted (which is the bypass we
 *     must close).
 *   - **Cloud vs dev mode is set by `INNGEST_DEV`** (the env var) or
 *     `isDev` (the client option). The SDK's mode-resolution chain is
 *     `options.isDev` → `INNGEST_DEV` env var → explicit URL →
 *     default cloud. DEV mode silently disables signature verification
 *     on `serve()`, regardless of whether `signingKey` is passed.
 *   - Joi D.4 enforces that `INNGEST_SIGNING_KEY` is set in
 *     staging/production. Joi D-hardening enforces that `INNGEST_DEV`
 *     is falsy in staging/production. AND `InngestService` pins
 *     `isDev: false` at construction in deployed envs as belt-and-braces.
 *     By the time this controller is constructed in prod, all three
 *     gates are closed and `serve()` runs in signed mode.
 *   - In dev (no signing key, INNGEST_DEV allowed), `serve()` runs
 *     unsigned — fine because the Inngest Dev Server is local and
 *     trusted.
 *
 * **Why `@All()` and `@Req()` / `@Res()`.** Inngest's SDK uses one of
 * three HTTP verbs (GET for introspection, PUT for sync, POST for
 * events). `@All` matches all three with a single handler. The
 * `(req, res, next)` signature is what `serve()` returns from
 * `inngest/express`; we forward the express request/response objects
 * straight through, so the SDK sees the raw headers/body it needs for
 * signature verification.
 *
 * **Why memoize `serve()`.** The SDK's `serve()` returns a middleware
 * that closes over the configured client + functions. We build it ONCE
 * at construction and reuse the same handler across requests — exactly
 * what the Inngest docs recommend.
 */
import {
  All,
  Controller,
  Inject,
  Req,
  Res,
  type Request,
  type Response,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { serve } from 'inngest/express';
import { InngestService } from './inngest.service';

type ExpressMiddleware = (req: unknown, res: unknown, next?: unknown) => void;

@Controller('api/inngest')
export class InngestController {
  private readonly handler: ExpressMiddleware;

  constructor(
    private readonly inngestService: InngestService,
    @Inject(ConfigService) configService: ConfigService,
  ) {
    // Build the handler ONCE — `serve()` returns a middleware that
    // closes over the configured client, functions, and signing key.
    const signingKey = configService.get<string>('INNGEST_SIGNING_KEY');

    this.handler = serve({
      client: this.inngestService.getClient(),
      // The SDK's `InngestFunction.Like[]` is the contract `serve()`
      // accepts; our service exposes `unknown[]` to avoid baking the
      // SDK's generic type machinery into the public surface. The cast
      // is safe — the SDK validates each entry at registration time.
      functions: this.inngestService.getFunctions() as never,
      ...(signingKey ? { signingKey } : {}),
    }) as unknown as ExpressMiddleware;
  }

  /**
   * Catch-all handler — Inngest sends GET (introspection), PUT (sync),
   * and POST (async) to this path. We forward the express objects
   * straight to the SDK middleware, which performs signature
   * verification and dispatches to the registered functions.
   */
  @All()
  handle(@Req() req: Request, @Res() res: Response): void {
    this.handler(req, res);
  }
}