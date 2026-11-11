/**
 * Delivery preferences of the signed-in person (contract §5.2, §3.10, §12.12):
 *
 *   GET   /me/notification-preferences  → {emailEnabled, soundEnabled}
 *   PATCH /me/notification-preferences  → the same shape, partial body
 *
 * Same guards as the notifications routes: `JwtAuthGuard → TenantContextGuard
 * → ActiveUserGuard`. The person always comes from the JWT. In-app notices
 * cannot be turned off; only email and sound are preferences, and they follow
 * the person across sucursales.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ActiveUserGuard } from '../../auth/guards/active-user.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { NotificationsService } from '../application/notifications.service';
import { NotificationPreferencesDto } from './notifications.dto';

type StaffRequest = Request & { user?: AuthenticatedUser };

@Controller('me/notification-preferences')
@UseGuards(JwtAuthGuard, TenantContextGuard, ActiveUserGuard)
export class NotificationPreferencesController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(@Req() req: StaffRequest) {
    return this.notifications.getPreferences(req.user?.userId ?? '');
  }

  /** At least one flag; the other keeps its stored value. */
  @Patch()
  @Header('Cache-Control', 'no-store')
  patch(@Body() body: NotificationPreferencesDto, @Req() req: StaffRequest) {
    if (body.emailEnabled === undefined && body.soundEnabled === undefined) {
      throw new BadRequestException('emailEnabled or soundEnabled is required');
    }
    return this.notifications.setPreferences(req.user?.userId ?? '', {
      ...(body.emailEnabled === undefined
        ? {}
        : { emailEnabled: body.emailEnabled }),
      ...(body.soundEnabled === undefined
        ? {}
        : { soundEnabled: body.soundEnabled }),
    });
  }
}
