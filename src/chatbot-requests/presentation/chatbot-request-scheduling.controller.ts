/**
 * Staff routes of scheduled conversations (unit 14; contract "Staff side"):
 *
 *   POST /chatbot-requests/:id/reschedule         read + update:ChatbotRequest
 *   GET  /chatbot-requests/:id/scheduling/slots   read:ChatbotRequest (Q15)
 *
 * The actor comes only from the JWT; `Idempotency-Key` and `expectedVersion`
 * are required, like every staff command. 200 for a first run and a replay.
 */
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { IsISO8601 } from 'class-validator';
import type { Request } from 'express';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { ActiveUserGuard } from '../../auth/guards/active-user.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import {
  SchedulingService,
  type SlotsAnswer,
  type StaffRescheduleView,
} from '../application/scheduling.service';
import {
  ExpectedVersionDto,
  IdempotencyKey,
} from './chatbot-request-commands.dto';
import { ChatbotRequestHttpFilter } from './chatbot-request-http.filter';

class RescheduleDto extends ExpectedVersionDto {
  @IsISO8601({ strict: true })
  scheduledFor!: string;
}

type StaffRequest = Request & { user?: AuthenticatedUser };

@Controller('chatbot-requests')
@UseGuards(JwtAuthGuard, TenantContextGuard, ActiveUserGuard, PermissionsGuard)
@UseFilters(ChatbotRequestHttpFilter)
export class ChatbotRequestSchedulingController {
  constructor(private readonly scheduling: SchedulingService) {}

  @Post(':id/reschedule')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(['read', 'ChatbotRequest'], ['update', 'ChatbotRequest'])
  async reschedule(
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string,
    @Body() body: RescheduleDto,
    @Req() req: StaffRequest,
  ): Promise<{
    request: StaffRescheduleView;
    customerNotice: { expected: boolean };
  }> {
    // Fail closed if a guard was bypassed: no user, no command.
    if (!req.user) throw new ForbiddenException();
    const request = await this.scheduling.staffReschedule({
      requestId: id,
      actorUserId: req.user.userId,
      idempotencyKey: key,
      expectedVersion: body.expectedVersion,
      scheduledFor: body.scheduledFor,
    });
    return { request, customerNotice: request.customerNotice };
  }

  @Get(':id/scheduling/slots')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(['read', 'ChatbotRequest'])
  slots(@Param('id', ParseUUIDPipe) id: string): Promise<SlotsAnswer> {
    return this.scheduling.staffSlots(id);
  }
}
