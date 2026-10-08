/**
 * HTTP CONTROLLER: cash-handover receipt and recipient custody discovery
 * (T3/S2,S3).
 *
 *   POST /cash-handovers/:id/receive → update:CashHandover (RECEIVE_HANDOVER)
 *   GET  /cash-handovers/custody     → read:CashHandover   (query CUSTODY)
 *
 * The receiving actor is the authenticated JWT subject; the application
 * re-checks that it matches the handover's bound recipient and that the
 * declaration precedes the receipt. The sender can never assert another
 * person's receipt through this body.
 *
 * Custody discovery is scoped by the application to the authenticated
 * recipient; the route accepts only `page`/`limit`, so a caller cannot supply
 * a recipient or tenant.
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
  type CashDocument,
  type ICashApplication,
} from '../cash-application.port';
import { requireCashActor, type CashRequestWithAbility } from './cash-actor';
import { IdempotencyKey } from './decorators/idempotency-key.decorator';
import { ReceiveHandoverDto } from './dto/handover.dto';
import { ListCustodyQueryDto } from './dto/query.dto';

@Controller('cash-handovers')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class CashHandoverController {
  constructor(
    @Inject(CASH_APPLICATION)
    private readonly application: ICashApplication,
  ) {}

  @Get('custody')
  @RequirePermissions(['read', 'CashHandover'])
  listCustody(
    @Query() query: ListCustodyQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: CashRequestWithAbility,
  ): Promise<CashDocument> {
    return this.application.query(requireCashActor(user, request), {
      kind: 'CUSTODY',
      page: { page: query.page, limit: query.limit },
    });
  }

  @Post(':id/receive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'CashHandover'])
  receiveHandover(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ReceiveHandoverDto,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: CashRequestWithAbility,
  ): Promise<CashDocument> {
    return this.application.execute(
      requireCashActor(user, request),
      {
        kind: 'RECEIVE_HANDOVER',
        id,
        receivedCents: body.receivedCents,
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
      },
      idempotencyKey,
    );
  }
}
