/**
 * NotificationConfigController — HTTP Adapter (Driver Port).
 *
 * Exposes the per-tenant notification configuration for the Notificaciones
 * UI. Mirrors `SatCatalogController` exactly:
 *
 *   - Guard stack: `JwtAuthGuard` → `TenantContextGuard` → `PermissionsGuard`.
 *   - GET requires `read:NotificationConfig`; PUT requires
 *     `update:NotificationConfig`. Both are tenant-scoped (config is per-
 *     tenant), so `TenantContextGuard` MUST be in the stack — the adapter
 *     (Slice B) uses the tenant-scoped Prisma client extension for all
 *     persistence.
 *   - The controller is THIN: it parses the DTO via the global
 *     `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`)
 *     and delegates everything else to `NotificationConfigService`. Policy
 *     (action-key validity, recipient tenant-membership) lives in the
 *     service — see `notification-config.service.ts`.
 *
 * Routes:
 *   GET /notification-config   → tenant's `{ enabled, recipients, enabledActions }`
 *   PUT /notification-config   → overwrite tenant's config (full replace)
 */
import {
  Body,
  Controller,
  Get,
  Put,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { NotificationConfigService } from './notification-config.service';
import { UpdateNotificationConfigDto } from './dto/update-notification-config.dto';

@Controller('notification-config')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class NotificationConfigController {
  constructor(private readonly service: NotificationConfigService) {}

  /** GET /notification-config — read the calling tenant's config. */
  @Get()
  @RequirePermissions(['read', 'NotificationConfig'])
  read() {
    return this.service.read();
  }

  /**
   * PUT /notification-config — full overwrite. Body is `UpdateNotificationConfigDto`;
   * the DTO accepts `enabledActions: string[]` and the service narrows it to
   * `NotificationActionKey[]` (policy lives in the service layer).
   */
  @Put()
  @RequirePermissions(['update', 'NotificationConfig'])
  replace(@Body() body: UpdateNotificationConfigDto) {
    return this.service.replace({
      enabled: body.enabled,
      recipientUserIds: body.recipientUserIds,
      // DTO is `string[]`; service re-validates against the locked v1 set.
      enabledActions: body.enabledActions as never,
    });
  }
}