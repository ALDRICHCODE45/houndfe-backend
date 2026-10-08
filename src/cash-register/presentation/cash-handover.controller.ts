/**
 * HTTP CONTROLLER: cash-handover receipt (T3/S2,S3).
 *
 *   POST /cash-handovers/:id/receive → update:CashHandover (RECEIVE_HANDOVER)
 *
 * The receiving actor is the authenticated JWT subject; the application
 * re-checks that it matches the handover's bound recipient and that the
 * declaration precedes the receipt. The sender can never assert another
 * person's receipt through this body.
 */
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
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
import { IdempotencyKey } from './decorators/idempotency-key.decorator';
import { ReceiveHandoverDto } from './dto/handover.dto';

@Controller('cash-handovers')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class CashHandoverController {
  constructor(
    @Inject(CASH_APPLICATION)
    private readonly application: ICashApplication,
  ) {}

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
