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
 *   GET /human-decisions       -> PENDING queue page (tenant-scoped)
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
 * RESPONSE SHAPE:
 *   - List returns EXACTLY
 *     `{ data: Pending[], pagination: { pageIndex, pageSize, totalCount,
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
 * SCOPE: NO resolve route, NO bot poll/ACK. HD-04d2 owns the dedicated
 * PostgreSQL/real-ALS proof; this route's tests use a mocked read port.
 */
import {
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import {
  HUMAN_DECISION_REVIEW_READ_REPOSITORY,
  type IHumanDecisionReviewReadRepository,
} from '../domain/human-decision-review-read.repository';
import {
  toHumanDecisionReviewResponse,
  type HumanDecisionReviewPendingResponse,
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
 * Exact list envelope. `data` is `Pending[]` by construction: an adapter
 * invariant violation (a non-PENDING row) fails closed instead of widening the
 * response type.
 */
export interface HumanDecisionListResponse {
  data: HumanDecisionReviewPendingResponse[];
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
  ) {}

  /**
   * `GET /human-decisions` — one page of the tenant PENDING review queue.
   * The query DTO pins `status=PENDING`, the `20 | 50` page sizes and the
   * `createdAt,asc` order; the controller forwards ONLY `{ page, limit,
   * search }`, so the transport never widens the tenant-scoped repository.
   */
  @Get()
  @RequirePermissions(['read', 'HumanDecision'])
  async list(
    @Query() query: ListHumanDecisionsQueryDto,
    @Req() request: RequestWithAbility,
  ): Promise<HumanDecisionListResponse> {
    const canResolve = this.canResolve(request);

    const page = await this.readRepository.listPending({
      page: query.page,
      limit: query.limit,
      search: query.search,
    });

    const data = page.items.map((item) => {
      const response = toHumanDecisionReviewResponse(item, canResolve);
      if (response.status !== 'PENDING') {
        // The port hardcodes `status: 'PENDING'`; a RESOLVED row here means an
        // adapter/tenant invariant was violated. Fail closed rather than
        // publish a resolved item in a PENDING-only queue.
        throw new Error('Human decision list returned a non-PENDING decision');
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
