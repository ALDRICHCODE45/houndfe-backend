/**
 * HD-04d1 — guarded HUMAN reviewer read routes (list + detail).
 *
 * Approved design (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`.
 *
 * NEW controller for the POS human reviewer, deliberately separate from
 * `BotRestockIntakeController` so the bot route, its `ServiceAuthGuard` and its
 * credential-derived tenant stay untouched. This slice exposes READ ONLY:
 *
 *   GET /human-decisions       -> PENDING queue or recent RESOLVED page
 *   GET /human-decisions/:id   -> one PENDING|RESOLVED decision (tenant-scoped)
 *
 * AUTHORITY MODEL:
 *   - Class-level `@UseGuards(JwtAuthGuard, TenantContextGuard,
 *     HumanDecisionActiveReviewerGuard, PermissionsGuard)` in that exact
 *     order: real bearer auth -> CLS tenant context -> current-account
 *     admission (revoked/inactive User) -> CASL permission check.
 *   - `@RequirePermissions(['read', 'HumanDecision'])` on both routes.
 *   - `canResolve` (the `allowedActions` capability hint) is DERIVED, never
 *     trusted from the body/query: it reads the CASL ability the
 *     `PermissionsGuard` already attached to `request.ability`. A missing
 *     ability fails closed with a sanitized 403, so a bypassed guard can never
 *     be mistaken for an authorized reviewer.
 *   - The authenticated principal MUST carry a non-empty `tenantId`. A
 *     tenantless token (for example a global superadmin) passes
 *     `TenantContextGuard` and its CASL read, so the controller re-checks
 *     `request.user.tenantId` BEFORE any read-port call and fails with a
 *     sanitized 403 instead of surfacing a generic 500 from the tenant-scoped
 *     adapter. This is reviewer-controller-local: no shared guard, adapter or
 *     global auth behavior changes.
 *   - No client-supplied tenant/actor/product authority is ever read. The read
 *     port derives `tenantId` from CLS and pins `source`/`type`; the controller
 *     forwards ONLY `{ page, limit, search }`.
 *
 * HD-04d2a adds the guarded WRITE route on the same controller:
 *
 *   POST /human-decisions/:id/resolve -> one-resolved|replayed decision
 *
 *   - Class guards (same exact order) + scoped filter are reused; the method
 *     pins `@RequirePermissions(['update', 'HumanDecision'])` and
 *     `@HttpCode(200)` so BOTH a first resolve and an idempotent replay answer
 *     `200` with the same immutable projection.
 *   - The body is an UNTRUSTED `unknown` run through the EXACT pure RESTOCK
 *     parser, then the EXPIRATION parser only when the RESTOCK boundary rejects
 *     its own fixed code, BEFORE the port; the parsed value is never echoed.
 *   - `actorUserId` and `actorIsSuperAdmin` come EXCLUSIVELY from the verified
 *     `request.user` (`JwtAuthGuard`); no body/query/param value can supply
 *     them. The command carries no `tenantId` (the adapter resolves it from CLS).
 *   - The response is ONLY `toHumanDecisionReviewResponse(result.decision,
 *     capability)`: the adapter `status` (`resolved`/`replayed`) and every
 *     bot-only/authority/PII column are never surfaced, and a replay performs
 *     NO second write (the controller performs no write of its own).
 *
 * RESPONSE SHAPE:
 *   - List returns EXACTLY
 *     `{ data: (Pending | Resolved)[], pagination: { pageIndex, pageSize, totalCount,
 *     pageCount } }`. `pageIndex` is the 0-based `pageIndex0` of the port.
 *   - Detail returns the pure `Pending | Resolved` projection from
 *     `toHumanDecisionReviewResponse`.
 *   - The repository record is NEVER returned directly: both routes project it
 *     through the pure mapper, so bot-only/authority/PII columns cannot leak.
 *
 * ERROR SANITIZATION: `@UseFilters(HumanDecisionHttpFilter)` is
 * controller-scoped, so guard, `ParseUUIDPipe`, global `ValidationPipe` and
 * repository failures are all reduced to the fixed
 * `{ statusCode, code, message }` envelope (never a raw validation array or an
 * echoed value). A missing/cross-tenant id is a sanitized 404 that does not
 * distinguish the two cases.
 *
 * SCOPE: guarded reviewer READ routes PLUS the HD-04d2a guarded resolve route;
 * NO bot poll/ACK. The resolve route's HTTP proof here uses a mocked resolve
 * port; HD-04d2b owns the dedicated PostgreSQL/real-ALS resolve/CAS proof.
 */
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import {
  HUMAN_DECISION_REVIEW_READ_REPOSITORY,
  type IHumanDecisionReviewReadRepository,
} from '../domain/human-decision-review-read.repository';
import {
  HUMAN_DECISION_REVIEW_RESOLVE_REPOSITORY,
  type IHumanDecisionReviewResolveRepository,
  type ResolveHumanDecisionCommand,
} from '../domain/human-decision-review-resolve.repository';
import {
  INVALID_RESOLVE_REQUEST_CODE,
  parseExpirationResolveHumanDecisionRequest,
  parseResolveHumanDecisionRequest,
  RESOLVE_PROVIDE_EXPIRATION_TEXT,
  RESOLVE_PROVIDE_RESTOCK_ESTIMATE,
  RESOLVE_REPORT_EXPIRATION_UNAVAILABLE,
  RESOLVE_REPORT_RESTOCK_ESTIMATE_UNAVAILABLE,
  type ResolveExpirationHumanDecisionRequest,
  type ResolveHumanDecisionRequest,
} from './dto/resolve-human-decision.request';
import {
  toHumanDecisionReviewResponse,
  type HumanDecisionReviewResponse,
} from './dto/human-decision-review.response';
import { ListHumanDecisionsQueryDto } from './dto/list-human-decisions.query';
import { HumanDecisionHttpFilter } from './filters/human-decision-http.filter';
import { HumanDecisionActiveReviewerGuard } from './guards/human-decision-active-reviewer.guard';

/**
 * Request augmentation: `JwtAuthGuard` sets `request.user` and
 * `PermissionsGuard` attaches the per-request CASL ability to
 * `request.ability`. The Express `Request` shape is widened inline, mirroring
 * the delivery-routes / catalog-settings controllers, so no global type
 * augmentation is required.
 */
type RequestWithAbility = Request & {
  ability?: AppAbility;
  user?: AuthenticatedUser;
};

/** FE pagination block: 0-based `pageIndex` plus the durable counts. */
export interface HumanDecisionListPaginationResponse {
  pageIndex: number;
  pageSize: number;
  totalCount: number;
  pageCount: number;
}

/**
 * Exact list envelope. Every row must match the requested status;
 * an adapter invariant violation fails closed.
 */
export interface HumanDecisionListResponse {
  data: HumanDecisionReviewResponse[];
  pagination: HumanDecisionListPaginationResponse;
}

@Controller('human-decisions')
@UseGuards(
  JwtAuthGuard,
  TenantContextGuard,
  HumanDecisionActiveReviewerGuard,
  PermissionsGuard,
)
@UseFilters(HumanDecisionHttpFilter)
export class HumanDecisionReviewController {
  constructor(
    @Inject(HUMAN_DECISION_REVIEW_READ_REPOSITORY)
    private readonly readRepository: IHumanDecisionReviewReadRepository,
    @Inject(HUMAN_DECISION_REVIEW_RESOLVE_REPOSITORY)
    private readonly resolveRepository: IHumanDecisionReviewResolveRepository,
  ) {}

  /**
   * Tenant PENDING queue or recent RESOLVED responses. The validated status
   * selects a fixed repository policy; only page/limit/search are forwarded.
   */
  @Get()
  @RequirePermissions(['read', 'HumanDecision'])
  async list(
    @Query() query: ListHumanDecisionsQueryDto,
    @Req() request: RequestWithAbility,
  ): Promise<HumanDecisionListResponse> {
    const canResolve = this.canResolve(request);

    const input = {
      page: query.page,
      limit: query.limit,
      search: query.search,
    };
    const page =
      query.status === 'ALL'
        ? await this.readRepository.listAll(input)
        : query.status === 'RESOLVED'
          ? await this.readRepository.listResolved(input)
          : await this.readRepository.listPending(input);

    const data = page.items.map((item) => {
      const response = toHumanDecisionReviewResponse(item, canResolve);
      if (query.status !== 'ALL' && response.status !== query.status) {
        throw new Error('Human decision list returned a mismatched status');
      }
      return response;
    });

    return {
      data,
      pagination: {
        pageIndex: page.pageIndex0,
        pageSize: page.pageSize,
        totalCount: page.totalCount,
        pageCount: page.pageCount,
      },
    };
  }

  /**
   * `GET /human-decisions/:id` — one tenant-scoped decision, PENDING or
   * RESOLVED. A malformed id is a sanitized 400 (`ParseUUIDPipe`); a missing
   * OR cross-tenant id is a sanitized 404 that never distinguishes the two.
   */
  @Get(':id')
  @RequirePermissions(['read', 'HumanDecision'])
  async detail(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: RequestWithAbility,
  ): Promise<HumanDecisionReviewResponse> {
    const canResolve = this.canResolve(request);

    const record = await this.readRepository.findById(id);
    if (record === null) {
      throw new NotFoundException('Human decision not found');
    }

    return toHumanDecisionReviewResponse(record, canResolve);
  }

  /**
   * `POST /human-decisions/:id/resolve` — resolve one tenant-scoped decision.
   *
   * The same class guards already proved the bearer JWT, wrote the CLS tenant,
   * admitted the active account and enforced `update:HumanDecision`. This
   * handler then:
   *   1. Fails closed with a sanitized 401 when no verified principal is
   *      attached (a bypassed `JwtAuthGuard`).
   *   2. Derives the capability from the guard-attached ability (`canResolve`),
   *      which also re-checks the tenant context before any write.
   *   3. Parses the UNTRUSTED body with the exact pure parsers (RESTOCK first,
   *      then EXPIRATION); a malformed or authority-bearing body is a sanitized
   *      400 BEFORE the port.
   *   4. Builds the EXACT discriminated command with one explicit branch per
   *      action and `actorUserId` / `actorIsSuperAdmin` taken ONLY from
   *      `request.user` (never the body) and no `tenantId` (the adapter resolves
   *      it from CLS). Each variant OMITS its absent `restockDays`/
   *      `expirationText` key entirely.
   *   5. Returns ONLY the pure reviewer projection: the adapter
   *      `resolved`/`replayed` status and every bot/authority/PII column stay
   *      server-side, so a replay is byte-identical and triggers no new write.
   */
  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'HumanDecision'])
  async resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() raw: unknown,
    @Req() request: RequestWithAbility,
  ): Promise<HumanDecisionReviewResponse> {
    const user = request.user;
    if (
      !user ||
      typeof user.userId !== 'string' ||
      user.userId.trim().length === 0
    ) {
      throw new UnauthorizedException('Authenticated user required');
    }

    const canResolve = this.canResolve(request);
    const parsed = parseReviewerResolveRequest(raw);
    const command = toResolveCommand(
      id,
      parsed,
      user.userId,
      user.isSuperAdmin === true,
    );

    const result = await this.resolveRepository.resolve(command);

    return toHumanDecisionReviewResponse(result.decision, canResolve);
  }

  /**
   * Derives the resolve capability from the guard-attached CASL ability, after
   * gating on the authenticated principal's tenant. Fails closed with a
   * sanitized 403 when the principal is tenantless (a global superadmin passes
   * the shared guards/CASL but must not reach the tenant-scoped read port) OR
   * when `PermissionsGuard` did not attach an ability (routing mistake).
   */
  private canResolve(request: RequestWithAbility): boolean {
    const tenantId = request.user?.tenantId;
    if (typeof tenantId !== 'string' || tenantId.trim().length === 0) {
      throw new ForbiddenException('Tenant context required');
    }

    const ability = request.ability;
    if (!ability || typeof ability.can !== 'function') {
      throw new ForbiddenException(
        'Human decision capability context required',
      );
    }
    return ability.can('update', 'HumanDecision');
  }
}

/**
 * HD-EXP-02b — route-level dispatch over the untrusted resolve body.
 *
 * The RESTOCK parser runs FIRST and keeps the EXACT existing behavior and `400`
 * codes for every RESTOCK request. Only when it rejects with its own fixed
 * `INVALID_RESOLVE_REQUEST_CODE` is the EXPIRATION parser tried. The controller
 * never reads `body.action` directly, so a hostile accessor/getter on an
 * arbitrary unknown object can never run before a parser owns it; both parsers
 * are value-free and fail closed with the same sanitized envelope.
 */
function parseReviewerResolveRequest(
  raw: unknown,
): ResolveHumanDecisionRequest | ResolveExpirationHumanDecisionRequest {
  try {
    return parseResolveHumanDecisionRequest(raw);
  } catch (error) {
    if (
      error instanceof InvalidArgumentError &&
      error.code === INVALID_RESOLVE_REQUEST_CODE
    ) {
      return parseExpirationResolveHumanDecisionRequest(raw);
    }
    throw error;
  }
}

/**
 * Builds the EXACT discriminated command with one explicit branch per supported
 * action. `actorUserId`/`actorIsSuperAdmin` are injected from the verified
 * principal; no body value is spread, and each variant deliberately OMITS the
 * key it must not carry (`restockDays`/`expirationText`).
 */
function toResolveCommand(
  decisionId: string,
  parsed: ResolveHumanDecisionRequest | ResolveExpirationHumanDecisionRequest,
  actorUserId: string,
  actorIsSuperAdmin: boolean,
): ResolveHumanDecisionCommand {
  switch (parsed.action) {
    case RESOLVE_PROVIDE_RESTOCK_ESTIMATE:
      return {
        decisionId,
        expectedVersion: parsed.expectedVersion,
        resolutionRequestId: parsed.resolutionRequestId,
        action: RESOLVE_PROVIDE_RESTOCK_ESTIMATE,
        restockDays: parsed.restockDays,
        actorUserId,
        actorIsSuperAdmin,
      };
    case RESOLVE_REPORT_RESTOCK_ESTIMATE_UNAVAILABLE:
      return {
        decisionId,
        expectedVersion: parsed.expectedVersion,
        resolutionRequestId: parsed.resolutionRequestId,
        action: RESOLVE_REPORT_RESTOCK_ESTIMATE_UNAVAILABLE,
        actorUserId,
        actorIsSuperAdmin,
      };
    case RESOLVE_PROVIDE_EXPIRATION_TEXT:
      return {
        decisionId,
        expectedVersion: parsed.expectedVersion,
        resolutionRequestId: parsed.resolutionRequestId,
        action: RESOLVE_PROVIDE_EXPIRATION_TEXT,
        expirationText: parsed.expirationText,
        actorUserId,
        actorIsSuperAdmin,
      };
    case RESOLVE_REPORT_EXPIRATION_UNAVAILABLE:
      return {
        decisionId,
        expectedVersion: parsed.expectedVersion,
        resolutionRequestId: parsed.resolutionRequestId,
        action: RESOLVE_REPORT_EXPIRATION_UNAVAILABLE,
        actorUserId,
        actorIsSuperAdmin,
      };
  }
}
