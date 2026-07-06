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
 *     internally. Unsigned requests to a configured signing key are
 *     rejected by the SDK with 401.
 *   - Joi D.4 enforces that `INNGEST_SIGNING_KEY` is set in
 *     staging/production — so by the time this controller is
 *     constructed in prod, the key is present, and `serve()` runs in
 *     signed mode.
 *   - In dev (no signing key), `serve()` runs unsigned — fine because
 *     the Inngest Dev Server is local and trusted.
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