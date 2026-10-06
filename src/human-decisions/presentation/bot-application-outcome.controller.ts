/**
 * HD-05c2a — `POST /chatbot-api/human-decisions/:id/application-outcome`
 * (bot terminal ACK).
 *
 * Contract (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`
 * ("ACK `{attemptId,expectedResolutionVersion,outcome,providerMessageId?,
 * providerAcceptedObservedAt?,attemptedAt?,evidenceCode?}` is one TERMINAL
 * outcome per request: backend hashes the canonical allowlisted evidence, exact
 * replay of the same attempt ID/hash returns the same result, changed payload
 * or second terminal attempt returns `409`").
 *
 * The sketch's `evidenceCode?` is superseded: the current HD-05b1 parser
 * FORBIDS `evidenceCode` on the wire (even as `null`), the canonical evidence
 * hash EXCLUDES it, and the reserved `applicationEvidenceCode` DB column is
 * always persisted `null` by the adapter.
 *
 * This is a NEW, separate controller so the existing bot `POST` intake
 * (`BotRestockIntakeController`) and the bot `GET` poll
 * (`BotRestockPollController`) keep their methods, guards and projections
 * untouched. All three share the `chatbot-api/human-decisions` prefix but never
 * a method+path pair.
 *
 * Boundaries:
 *   - `ServiceAuthGuard` authenticates the service credential, pins the trusted
 *     tenant into CLS and sets `request.serviceCredential`. The controller fails
 *     closed with a sanitized 401 when that trusted context is absent, so a
 *     routing mistake can never record an ACK unauthenticated.
 *   - `@RequiredScopes('human-decisions:ack')` is method-scoped, so a
 *     create/read-only credential is rejected with a sanitized 403 BEFORE the
 *     port.
 *   - The caller supplies ONLY `:id`. `ParseUUIDPipe` alone is NOT sufficient:
 *     Nest 11's `uuidRegExps.all` is case-insensitive and version-agnostic, so
 *     it accepts the nil UUID and uppercase ids that the Prisma ACK adapter
 *     rejects. The route therefore re-checks the id with a canonical RFC 4122
 *     v1-v8 lowercase variant pattern AFTER the pipe and BEFORE the port,
 *     returning a fixed value-free `BadRequestException` (sanitized 400)
 *     instead of a false 500.
 *   - The body is parsed by the EXACT pure parser
 *     `parseBotApplicationOutcomeRequest` from an `unknown` value: the handler
 *     declares `@Body() body: unknown`, whose emitted metatype is `Object`, so
 *     the global `ValidationPipe` never whitelists/strips/forbids unknown keys.
 *     `decisionId`, `tenantId`, `source`, `credentialId`, an `evidenceCode` and
 *     any other authority key are rejected by the parser, never silently
 *     dropped. A malformed body is a sanitized 400 BEFORE the port.
 *   - The port command is EXACTLY `{decisionId: id, request: parsed}`. The
 *     trusted tenant, `source`, `type`, `ackReceivedAt` and the evidence hash
 *     are NEVER command fields: the adapter resolves the tenant from CLS and
 *     derives the rest itself.
 *   - The response is ONLY `toBotApplicationOutcomeResponse(result
 *     .acknowledgment)`: an exact five-key projection, HTTP 200 on the first
 *     commit AND on an exact replay (a second terminal attempt is a 409 from
 *     the port, never a second mutation).
 *   - `Cache-Control: no-store` is set inside the handler, so success AND every
 *     handler-level error (including the parser 400 and the port's mapped
 *     errors) carry it. Early guard/pipe rejections (401, 403, 429 and the
 *     `ParseUUIDPipe` 400) throw BEFORE the header is set, so this module makes
 *     NO caching guarantee for them.
 *
 * `@UseFilters(HumanDecisionHttpFilter)` is controller-scoped so every thrown
 * value — guard, pipe, parser or repository — is reduced to the sanitized
 * `{statusCode, code, message}` envelope, overriding the global filters.
 */
import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { RequiredScopes } from '../../chatbot-api/presentation/decorators/required-scopes.decorator';
import { ServiceAuthGuard } from '../../chatbot-api/presentation/guards/service-auth.guard';
import { parseBotApplicationOutcomeRequest } from '../domain/bot-application-outcome.request';
import {
  BOT_APPLICATION_OUTCOME_REPOSITORY,
  type IBotApplicationOutcomeRepository,
} from '../domain/bot-application-outcome.repository';
import {
  toBotApplicationOutcomeResponse,
  type BotApplicationOutcomeResponse,
} from './dto/bot-application-outcome.response';
import { HumanDecisionHttpFilter } from './filters/human-decision-http.filter';

/** Minimal trusted view of the request the guard decorated. */
interface ServiceAuthenticatedRequest extends Request {
  serviceCredential?: { id: string };
}

/**
 * Canonical RFC 4122 v1-v8, variant 8/9/a/b, LOWERCASE only. Mirrors the
 * `PrismaBotApplicationOutcomeRepository` id policy exactly, so any id this
 * route accepts can reach the adapter; the nil UUID (version nibble `0`) and
 * every uppercase form are rejected here as a client 400 rather than a 500.
 */
const CANONICAL_DECISION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

@Controller('chatbot-api/human-decisions')
@UseGuards(ServiceAuthGuard)
@UseFilters(HumanDecisionHttpFilter)
export class BotApplicationOutcomeController {
  constructor(
    @Inject(BOT_APPLICATION_OUTCOME_REPOSITORY)
    private readonly outcomeRepository: IBotApplicationOutcomeRepository,
  ) {}

  /**
   * Records ONE terminal application outcome for a tenant-scoped RESTOCK
   * decision. A malformed `:id` is a sanitized 400 (`ParseUUIDPipe` plus the
   * local canonical re-check). A missing OR cross-tenant/foreign-source id is
   * an indistinguishable sanitized 404 raised by the port. The trusted
   * credential context is required: if the guard did not populate it, the
   * route fails closed with a sanitized 401 instead of recording.
   */
  @Post(':id/application-outcome')
  @RequiredScopes('human-decisions:ack')
  @HttpCode(HttpStatus.OK)
  async create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() request: ServiceAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BotApplicationOutcomeResponse> {
    if (!request.serviceCredential) {
      // The guard always sets this; a missing value means the trusted
      // credential context was lost, so deny rather than record an
      // unauthenticated terminal outcome.
      throw new UnauthorizedException('Service credential context required');
    }

    // `ParseUUIDPipe` accepts the nil UUID and uppercase ids; without this
    // re-check they would reach the adapter, be rejected and surface as a
    // misleading 500. Reject them here as a fixed, value-free client 400 BEFORE
    // the port. The `no-store` header is set AFTER this early 400, so this
    // route makes no caching claim for the canonical-id rejection.
    this.assertCanonicalDecisionId(id);

    // A terminal ACK is a mutation, so neither the success nor any handler-level
    // error may be cached. Set it BEFORE the parser/port so both carry it.
    response.setHeader('Cache-Control', 'no-store');

    const parsed = parseBotApplicationOutcomeRequest(body);

    const result = await this.outcomeRepository.record({
      decisionId: id,
      request: parsed,
    });

    return toBotApplicationOutcomeResponse(result.acknowledgment);
  }

  /**
   * Rejects any id the Prisma ACK adapter would reject, so a client mistake is a
   * 400 and never a 500. The fixed message is never derived from the rejected
   * value, so nothing is echoed back to the caller.
   */
  private assertCanonicalDecisionId(id: string): void {
    if (!CANONICAL_DECISION_ID_PATTERN.test(id)) {
      throw new BadRequestException('Invalid human decision id');
    }
  }
}
