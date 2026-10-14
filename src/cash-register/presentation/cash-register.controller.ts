/**
 * HTTP CONTROLLER: cash-register administration (T3/S1,S3).
 *
 * Thin adapter over `ICashApplication` for named POS registers inside the
 * authenticated tenant. Class-level guard order is
 * `JwtAuthGuard → TenantContextGuard → PermissionsGuard`; the tenant boundary
 * and actor come exclusively from the verified JWT and the `request.ability`
 * attached by the real guard. The client never supplies `tenantId`, an actor,
 * an ability or a command kind.
 *
 * Routes:
 *   GET   /cash-registers      → read:CashRegister   (query REGISTERS)
 *   POST  /cash-registers      → create:CashRegister (command CREATE_REGISTER)
 *   PATCH /cash-registers/:id  → update:CashRegister (command UPDATE_REGISTER)
 *
 * Params use `id` (not `registerId`) so the CASL subject-instance resolver
 * seam, when registered later, can resolve the instance; the application
 * enforces tenant/ownership scope regardless.
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
  Patch,
  Post,
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
  type CashDocument,
  type ICashApplication,
} from '../cash-application.port';
import { requireCashActor, type CashRequestWithAbility } from './cash-actor';
import { CreateRegisterDto, UpdateRegisterDto } from './dto/register.dto';
import { OpenSessionDto } from './dto/session.dto';
import { IdempotencyKey } from './decorators/idempotency-key.decorator';

@Controller('cash-registers')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class CashRegisterController {
  constructor(
    @Inject(CASH_APPLICATION)
    private readonly application: ICashApplication,
  ) {}

  @Get()
  @RequirePermissions(['read', 'CashRegister'])
  listRegisters(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: CashRequestWithAbility,
  ): Promise<CashDocument> {
    return this.application.query(requireCashActor(user, request), {
      kind: 'REGISTERS',
    });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'CashRegister'])
  createRegister(
    @Body() body: CreateRegisterDto,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: CashRequestWithAbility,
  ): Promise<CashDocument> {
    return this.application.execute(
      requireCashActor(user, request),
      { kind: 'CREATE_REGISTER', name: body.name },
      idempotencyKey,
    );
  }

  @Post(':id/sessions')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'CashSession'])
  openSession(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: OpenSessionDto,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: CashRequestWithAbility,
  ): Promise<CashDocument> {
    return this.application.execute(
      requireCashActor(user, request),
      {
        kind: 'OPEN_SESSION',
        registerId: id,
        openingCents: body.openingCents,
        ...(body.openingHandoverId !== undefined
          ? { openingHandoverId: body.openingHandoverId }
          : {}),
        openingConfirmed: body.openingConfirmed,
      },
      idempotencyKey,
    );
  }

  @Patch(':id')
  @RequirePermissions(['update', 'CashRegister'])
  updateRegister(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateRegisterDto,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: CashRequestWithAbility,
  ): Promise<CashDocument> {
    return this.application.execute(
      requireCashActor(user, request),
      {
        kind: 'UPDATE_REGISTER',
        id,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
      idempotencyKey,
    );
  }
}
