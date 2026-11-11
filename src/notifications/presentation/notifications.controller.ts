/**
 * Notifications of the signed-in person (contract §5.2). Any active member of
 * the tenant may call these: they only ever touch the caller's own rows, so
 * there is no CASL permission, only `JwtAuthGuard → TenantContextGuard →
 * ActiveUserGuard`. In-app notices cannot be turned off.
 *
 *   GET  /notifications?cursor=&limit=&unread=
 *   GET  /notifications/unread-count
 *   POST /notifications/read-all
 *   POST /notifications/:id/read
 *   GET  /notifications/preferences
 *   PUT  /notifications/preferences
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ActiveUserGuard } from '../../auth/guards/active-user.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { NotificationsService } from '../application/notifications.service';
import {
  ListNotificationsQuery,
  NotificationPreferencesDto,
} from './notifications.dto';

type StaffRequest = Request & { user?: AuthenticatedUser };

/** The id always comes from the verified JWT, never from the request. */
const callerId = (req: StaffRequest): string => req.user?.userId ?? '';

@Controller('notifications')
@UseGuards(JwtAuthGuard, TenantContextGuard, ActiveUserGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Query() query: ListNotificationsQuery, @Req() req: StaffRequest) {
    return this.notifications.list(callerId(req), query);
  }

  @Get('unread-count')
  @Header('Cache-Control', 'no-store')
  unreadCount(@Req() req: StaffRequest) {
    return this.notifications.unreadCount(callerId(req));
  }

  @Post('read-all')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  readAll(@Req() req: StaffRequest) {
    return this.notifications.markAllRead(callerId(req));
  }

  @Get('preferences')
  @Header('Cache-Control', 'no-store')
  getPreferences(@Req() req: StaffRequest) {
    return this.notifications.getPreferences(callerId(req));
  }

  @Put('preferences')
  @Header('Cache-Control', 'no-store')
  setPreferences(
    @Body() body: NotificationPreferencesDto,
    @Req() req: StaffRequest,
  ) {
    if (body.emailEnabled === undefined && body.soundEnabled === undefined) {
      throw new BadRequestException('emailEnabled or soundEnabled is required');
    }
    return this.notifications.setPreferences(callerId(req), {
      ...(body.emailEnabled === undefined
        ? {}
        : { emailEnabled: body.emailEnabled }),
      ...(body.soundEnabled === undefined
        ? {}
        : { soundEnabled: body.soundEnabled }),
    });
  }

  @Post(':id/read')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  read(@Param('id', ParseUUIDPipe) id: string, @Req() req: StaffRequest) {
    return this.notifications.markRead(callerId(req), id);
  }
}
