/**
 * `GET /realtime/stream` — the staff SSE stream (human-intervention unit 8;
 * contract §5.3, §6.4, §10.1 R5/R6, §12.1, §12.2, §12.8).
 *
 * Same admission as every staff route: `JWT → tenant → active user → CASL`
 * with `read:ChatbotRequest` (tenant and user come from the verified JWT, never
 * from the query). The stream is read with `fetch` (the browser sends
 * `Authorization`), resumes with `Last-Event-ID` (or `?after=` for clients that
 * cannot set the header) and ends at the token's `exp` with `auth-expired`.
 *
 * Anti-buffering (R6): `Content-Type: text/event-stream`, `Cache-Control:
 * no-store`, `X-Accel-Buffering: no`, `Connection: keep-alive`. No compression
 * (the app has no compression middleware, and `Content-Encoding: identity`
 * makes proxies that compress by default, Traefik included, leave it alone).
 * The hub writes a heartbeat every 15 s. NOT yet proven behind the production
 * Traefik/Swarm: the owner test of R6 is pending, so the frontend keeps polling
 * until it passes.
 *
 * The controller only does HTTP: parse the cursor, open the response, hand the
 * socket to the hub, free the slot when the client goes away. Every decision
 * about what to send lives in `RealtimeHub`.
 */
import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { ActiveUserGuard } from '../../auth/guards/active-user.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { RealtimeHub } from '../application/realtime-hub.service';
import type { StreamSink } from '../application/realtime-stream';
import {
  formatSseFrame,
  parseEventCursor,
  STREAM_LIMITS,
  tokenExpiryMs,
} from '../domain/realtime-events';

type StaffRequest = Request & {
  user?: AuthenticatedUser;
  ability?: AppAbility;
};

/** The HTTP response seen as the sink of one stream. */
function sinkOf(res: Response): StreamSink {
  return {
    write: (chunk) => res.write(chunk),
    end: (chunk) => {
      if (chunk) res.end(chunk);
      else res.end();
    },
    destroy: () => {
      res.destroy();
    },
    get bufferedBytes() {
      return res.writableLength;
    },
    onDrain: (callback) => {
      res.once('drain', callback);
    },
  };
}

@Controller('realtime')
@UseGuards(JwtAuthGuard, TenantContextGuard, ActiveUserGuard, PermissionsGuard)
export class RealtimeController {
  constructor(private readonly hub: RealtimeHub) {}

  @Get('stream')
  @RequirePermissions(['read', 'ChatbotRequest'])
  async stream(
    @Req() req: StaffRequest,
    @Res() res: Response,
    @Headers('last-event-id') lastEventId?: string,
    @Query('after') after?: string,
  ): Promise<void> {
    const user = req.user;
    const ability = req.ability;
    if (!user?.tenantId || !ability) {
      // The guards guarantee both; fail closed rather than stream anonymously.
      throw new BadRequestException('Tenant context required');
    }
    const cursor = parseEventCursor(lastEventId, after);
    if (cursor === undefined) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invalid Last-Event-ID',
      });
    }
    if (!this.hub.canAccept()) {
      res.setHeader('Retry-After', '5');
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'STREAM_CAPACITY',
        message: 'Too many open streams on this server; retry shortly',
      });
    }

    // The replica must be able to serve realtime BEFORE the 200 goes out: an
    // empty 200 gives the client no signal (it would just retry forever).
    try {
      await this.hub.ensureReady();
    } catch {
      res.setHeader('Retry-After', '5');
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'REALTIME_UNAVAILABLE',
        message: 'Realtime is temporarily unavailable; retry shortly',
      });
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Content-Encoding', 'identity');
    res.flushHeaders();
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    req.socket.setTimeout(0);

    let handle: { dispose(): void } | null = null;
    let gone = false;
    res.on('close', () => {
      gone = true;
      handle?.dispose();
    });

    try {
      handle = await this.hub.connect({
        tenantId: user.tenantId,
        userId: user.userId,
        ability,
        sink: sinkOf(res),
        after: cursor,
        expiresAtMs:
          tokenExpiryMs(req.headers.authorization) ??
          Date.now() + STREAM_LIMITS.defaultTokenLifetimeMs,
      });
    } catch {
      // The headers are already out (the subscription failed between the
      // check above and now): say so with a control event and close, so the
      // client backs off and reconnects instead of reading an empty 200.
      res.end(
        formatSseFrame({
          event: 'server-unavailable',
          data: { reason: 'REALTIME_UNAVAILABLE' },
        }),
      );
      return;
    }
    if (handle === null) {
      // Filled up between the check and now (the headers are already sent).
      res.end();
    } else if (gone) {
      handle.dispose();
    }
  }
}
