/**
 * HTTP CONTROLLER: cash-session lifecycle (T3/S2,S3,S4,S5,S6,S8).
 *
 * One route per operation, each mapping to exactly one `CashCommand`
 * discriminant chosen by this adapter (never by the client body). Class-level
 * guard order is `JwtAuthGuard → TenantContextGuard → PermissionsGuard`.
 *
 * Routes:
 *   GET  /cash-sessions                     → read:CashSession   query SESSIONS
 *   GET  /cash-sessions/:id                 → read:CashSession   query SESSION
 *   POST /cash-sessions/:id/start-count     → create:CashCount      START_COUNT
 *   POST /cash-sessions/:id/declarations    → create:CashCount      DECLARE
 *   POST /cash-sessions/:id/declaration-notes → create:CashCount    ANNOTATE_DECLARATION
 *   POST /cash-sessions/:id/verifications   → create:CashVerification VERIFY
 *   POST /cash-sessions/:id/cash-in         → create:CashIn       CASH_IN
 *   POST /cash-sessions/:id/cash-out        → create:CashOut      CASH_OUT
 *   POST /cash-sessions/:id/handovers       → create:CashHandover CREATE_HANDOVER
 *   POST /cash-sessions/:id/release-drawer  → create:CashHandover RELEASE_DRAWER
 *   POST /cash-sessions/:id/close           → create:CashClosing  CLOSE
 *
 * The declaration routes are blind: the controller never accepts or validates
 * an expected/difference value, and the application persists the first
 * declaration before comparing. `declaration-notes` is the ONLY post-submission
 * explanation path (immutable same-count revision).
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import {
  CASH_APPLICATION,
  type CashCommand,
  type CashCountInput,
  type CashDocument,
  type ICashApplication,
} from '../cash-application.port';
import { requireCashActor, type CashRequestWithAbility } from './cash-actor';
import { toCashPageInput } from './cash-query.mapper';
import { IdempotencyKey } from './decorators/idempotency-key.decorator';
import { ListSessionsQueryDto } from './dto/query.dto';
import { CreateHandoverDto } from './dto/handover.dto';
import {
  AnnotateDeclarationDto,
  CashCountDto,
  CashMovementDto,
  CloseSessionDto,
} from './dto/session.dto';

/** Build the blind-count command payload shared by declare and verify. */
function toCashCountInput(body: CashCountDto): CashCountInput {
  return {
    lines: body.lines,
    ...(body.denominations !== undefined
      ? { denominations: body.denominations }
      : {}),
    ...(body.notes !== undefined ? { notes: body.notes } : {}),
  };
}

@Controller('cash-sessions')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class CashSessionController {
  constructor(
    @Inject(CASH_APPLICATION)
    private readonly application: ICashApplication,
  ) {}

  @Get()
  @RequirePermissions(['read', 'CashSession'])
  listSessions(
    @Query() query: ListSessionsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: CashRequestWithAbility,
  ): Promise<CashDocument> {
    return this.application.query(requireCashActor(user, request), {
      kind: 'SESSIONS',
      page: toCashPageInput(query),
      ...(query.pendingOnly !== undefined
        ? { pendingOnly: query.pendingOnly }
        : {}),
    });
  }

  @Get(':id')
  @RequirePermissions(['read', 'CashSession'])
  getSession(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: CashRequestWithAbility,
  ): Promise<CashDocument> {
    return this.application.query(requireCashActor(user, request), {
      kind: 'SESSION',
      id,
    });
  }

  @Post(':id/start-count')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['create', 'CashCount'])
  startCount(
    @Param('id', new ParseUUIDPipe()) id: string,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: CashRequestWithAbility,
  ): Promise<CashDocument> {
    return this.application.execute(
      requireCashActor(user, request),
      { kind: 'START_COUNT', sessionId: id },
      idempotencyKey,
    );
  }

  @Post(':id/declarations')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'CashCount'])
  declare(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CashCountDto,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: CashRequestWithAbility,
  ): Promise<CashDocument> {
    const command: CashCommand = {
      kind: 'DECLARE',
      sessionId: id,
      ...toCashCountInput(body),
    };
    return this.application.execute(
      requireCashActor(user, request),
      command,
      idempotencyKey,
    );
  }

  @Post(':id/declaration-notes')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'CashCount'])
  annotateDeclaration(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: AnnotateDeclarationDto,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: CashRequestWithAbility,
  ): Promise<CashDocument> {
    return this.application.execute(
      requireCashActor(user, request),
      { kind: 'ANNOTATE_DECLARATION', sessionId: id, notes: body.notes },
      idempotencyKey,
    );
  }

  @Post(':id/verifications')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'CashVerification'])
  verify(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CashCountDto,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: CashRequestWithAbility,
  ): Promise<CashDocument> {
    const command: CashCommand = {
      kind: 'VERIFY',
      sessionId: id,
      ...toCashCountInput(body),
    };
    return this.application.execute(
      requireCashActor(user, request),
      command,
      idempotencyKey,
    );
  }

  @Post(':id/cash-in')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'CashIn'])
  cashIn(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CashMovementDto,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: CashRequestWithAbility,
  ): Promise<CashDocument> {
    return this.application.execute(
      requireCashActor(user, request),
      {
        kind: 'CASH_IN',
        sessionId: id,
        amountCents: body.amountCents,
        reason: body.reason,
      },
      idempotencyKey,
    );
  }

  @Post(':id/cash-out')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'CashOut'])
  cashOut(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CashMovementDto,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: CashRequestWithAbility,
  ): Promise<CashDocument> {
    return this.application.execute(
      requireCashActor(user, request),
      {
        kind: 'CASH_OUT',
        sessionId: id,
        amountCents: body.amountCents,
        reason: body.reason,
      },
      idempotencyKey,
    );
  }

  @Post(':id/handovers')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'CashHandover'])
  createHandover(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CreateHandoverDto,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: CashRequestWithAbility,
  ): Promise<CashDocument> {
    return this.application.execute(
      requireCashActor(user, request),
      {
        kind: 'CREATE_HANDOVER',
        sessionId: id,
        handoverKind: body.handoverKind,
        recipientUserId: body.recipientUserId,
        declaredCents: body.declaredCents,
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
      },
      idempotencyKey,
    );
  }

  @Post(':id/release-drawer')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['create', 'CashHandover'])
  releaseDrawer(
    @Param('id', new ParseUUIDPipe()) id: string,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: CashRequestWithAbility,
  ): Promise<CashDocument> {
    return this.application.execute(
      requireCashActor(user, request),
      { kind: 'RELEASE_DRAWER', sessionId: id },
      idempotencyKey,
    );
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'CashClosing'])
  close(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CloseSessionDto,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: CashRequestWithAbility,
  ): Promise<CashDocument> {
    return this.application.execute(
      requireCashActor(user, request),
      {
        kind: 'CLOSE',
        sessionId: id,
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
      },
      idempotencyKey,
    );
  }
}
