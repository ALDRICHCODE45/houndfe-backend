/**
 * HD-05c — `GET /chatbot-api/human-decisions/:id` (bot CURRENT-state poll).
 *
 * Contract (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`
 * ("Historical POST vs current GET").
 *
 * This is a NEW, separate controller so the existing bot `POST` intake
 * (`BotRestockIntakeController`) keeps its immutable historical receipt and its
 * own guard/route untouched. Both controllers share the
 * `chatbot-api/human-decisions` prefix but never a method: `POST /` stays the
 * create/replay intake, `GET /:id` is this tenant-scoped current-state poll.
 *
 * Boundaries:
 *   - `ServiceAuthGuard` authenticates the service credential, pins the trusted
 *     tenant into CLS and sets `request.serviceCredential`. The controller fails
 *     closed with a sanitized 401 when that trusted context is absent, so a
 *     routing mistake can never expose the read route unauthenticated.
 *   - `@RequiredScopes('human-decisions:read')` is method-scoped, so a
 *     create-only credential is rejected with a sanitized 403 BEFORE the port.
 *   - The caller supplies ONLY `:id`. `ParseUUIDPipe` alone is NOT sufficient:
 *     Nest 11's `uuidRegExps.all` is case-insensitive and version-agnostic, so
 *     it accepts the nil UUID and uppercase ids that the Prisma poll adapter
 *     rejects. The route therefore re-checks the id with a canonical RFC 4122
 *     v1-v8 lowercase variant pattern AFTER the pipe and BEFORE the port,
 *     returning a fixed value-free `BadRequestException` (sanitized 400)
 *     instead of a 500 from `BotRestockPollReadError`. `tenantId`, `source` and
 *     `type` are NEVER read from the body/query/headers. The adapter resolves
 *     the tenant from CLS and pins `source`/`type` in the same WHERE clause, so
 *     a missing, cross-tenant or foreign-source id is indistinguishable and the
 *     port returns `null`.
 *   - The response is an exact discriminated projection of the CURRENT
 *     decision state (PENDING or RESOLVED) with reviewer identity, authority,
 *     credential, provider/ACK and customer fields excluded by construction.
 *     Dispatch is by the persisted `type`: RESTOCK projects through
 *     `toBotRestockPollResponse`, EXPIRATION through
 *     `toBotExpirationPollResponse` (both value-free and fail-closed); any
 *     other type fails closed as a sanitized 500. NOTE: the production adapter
 *     (`PrismaBotRestockPollRepository`) still pins `type = RESTOCK`, so the
 *     live GET route is RESTOCK-only until the pending adapter slice — the
 *     EXPIRATION branch is contract-tested against the mocked port here.
 *   - Because the poll is mutable, the route is pinned `Cache-Control: no-store`
 *     BEFORE the port read, so a success (200) AND a handler-level miss (404)
 *     both carry it. `no-store` is NOT guaranteed on early guard/pipe/route
 *     rejections (401, 403, 429 and the 400 above, all of which throw before the
 *     header is set); this module makes NO caching guarantee for those.
 *
 * `@UseFilters(HumanDecisionHttpFilter)` is controller-scoped so every thrown
 * value — guard, pipe, `NotFoundException` or repository — is reduced to the
 * sanitized `{statusCode, code, message}` envelope, overriding the global
 * filters.
 */
import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Req,
  Res,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { RequiredScopes } from '../../chatbot-api/presentation/decorators/required-scopes.decorator';
import { ServiceAuthGuard } from '../../chatbot-api/presentation/guards/service-auth.guard';
import {
  BOT_RESTOCK_POLL_REPOSITORY,
  type BotRestockPollRecord,
  type IBotRestockPollRepository,
} from '../domain/bot-restock-poll.repository';
import { EXPIRATION_TYPE } from '../domain/expiration-intake.request';
import { RESTOCK_TYPE } from '../domain/restock-request-canonicalizer';
import {
  toBotExpirationPollResponse,
  toBotRestockPollResponse,
  type BotExpirationPollResponse,
  type BotRestockPollResponse,
} from './dto/bot-restock-poll.response';
import { HumanDecisionHttpFilter } from './filters/human-decision-http.filter';

/** Minimal trusted view of the request the guard decorated. */
interface ServiceAuthenticatedRequest extends Request {
  serviceCredential?: { id: string };
}

/**
 * Canonical RFC 4122 v1-v8, variant 8/9/a/b, LOWERCASE only. Mirrors the
 * `PrismaBotRestockPollRepository` argument guard exactly, so any id this route
 * accepts can reach the adapter; the nil UUID (version nibble `0`) and any
 * uppercase form are rejected here as a client 400 rather than a 500.
 */
const CANONICAL_DECISION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

@Controller('chatbot-api/human-decisions')
@UseGuards(ServiceAuthGuard)
@UseFilters(HumanDecisionHttpFilter)
export class BotRestockPollController {
  constructor(
    @Inject(BOT_RESTOCK_POLL_REPOSITORY)
    private readonly pollRepository: IBotRestockPollRepository,
  ) {}

  /**
   * One tenant-scoped decision in its CURRENT state. A malformed `:id` is a
   * sanitized 400: `ParseUUIDPipe` catches non-UUID shapes, and the local
   * canonical re-check catches the pipe's over-acceptance (nil/uppercase). A
   * missing OR cross-tenant/foreign-source id is an indistinguishable
   * sanitized 404. The trusted credential context is required: if the guard did
   * not populate it, the route fails closed with a sanitized 401 instead of
   * reading.
   */
  @Get(':id')
  @RequiredScopes('human-decisions:read')
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: ServiceAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BotRestockPollResponse | BotExpirationPollResponse> {
    if (!request.serviceCredential) {
      // The guard always sets this; a missing value means the trusted
      // credential context was lost, so deny rather than serve an
      // unauthenticated read.
      throw new UnauthorizedException('Service credential context required');
    }

    // `ParseUUIDPipe` accepts the nil UUID and uppercase ids; without this
    // re-check they would reach the adapter, be rejected as a value-free
    // `BotRestockPollReadError` and surface as a misleading 500. Reject them
    // here as a fixed, value-free client 400 BEFORE the port and BEFORE the
    // `no-store` header (so early 400s make no caching claim).
    this.assertCanonicalDecisionId(id);

    // The poll reads mutable current state, so it must never be cached.
    response.setHeader('Cache-Control', 'no-store');

    const record = await this.pollRepository.findById(id);
    if (record === null) {
      throw new NotFoundException('Human decision not found');
    }

    return this.toPollResponse(record);
  }

  /**
   * Dispatches on the persisted decision `type`. Both projections are pure,
   * value-free and fail closed on malformed state; an unsupported type is a
   * programmer/transport-bypass state that must never be served, so it throws
   * a value-free `Error` the scoped filter reduces to a sanitized 500.
   */
  private toPollResponse(
    record: BotRestockPollRecord,
  ): BotRestockPollResponse | BotExpirationPollResponse {
    switch (record.type) {
      case RESTOCK_TYPE:
        return toBotRestockPollResponse(record);
      case EXPIRATION_TYPE:
        return toBotExpirationPollResponse(record);
      default:
        throw new Error('Unsupported human decision type');
    }
  }

  /**
   * Rejects any id the Prisma poll adapter would reject with a value-free
   * `BotRestockPollReadError`, so a client mistake is a 400 and never a 500.
   * The fixed message is never derived from the rejected value, so nothing is
   * echoed back to the caller.
   */
  private assertCanonicalDecisionId(id: string): void {
    if (!CANONICAL_DECISION_ID_PATTERN.test(id)) {
      throw new BadRequestException('Invalid human decision id');
    }
  }
}
