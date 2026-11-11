/**
 * Chatbot attention settings (contract §5.5, §12.9, S7):
 *
 *   GET  /chatbot-settings                       read:ChatbotSettings
 *   PUT  /chatbot-settings                       read + update:ChatbotSettings
 *   POST /chatbot-settings/apply-to-all-tenants  update:ChatbotSettingsAllBranches
 *
 * The tenant and the actor come only from the JWT.
 */
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { ActiveUserGuard } from '../../auth/guards/active-user.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { ChatbotSettingsService } from '../application/chatbot-settings.service';
import type { AttentionSettingsInput } from '../domain/chatbot-attention-settings';
import { ChatbotSettingsHttpFilter } from './chatbot-settings.filter';
import { ApplyToAllDto, PutChatbotSettingsDto } from './chatbot-settings.dto';

/** `ActiveUserGuard` already refuses a token without a tenant; this narrows the type. */
function tenantOf(user: AuthenticatedUser): string {
  if (!user.tenantId) throw new ForbiddenException('Tenant context required');
  return user.tenantId;
}

@Controller('chatbot-settings')
@UseGuards(JwtAuthGuard, TenantContextGuard, ActiveUserGuard, PermissionsGuard)
@UseFilters(ChatbotSettingsHttpFilter)
export class ChatbotSettingsController {
  constructor(private readonly settings: ChatbotSettingsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(['read', 'ChatbotSettings'])
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.settings.get(tenantOf(user));
  }

  @Put()
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(
    ['read', 'ChatbotSettings'],
    ['update', 'ChatbotSettings'],
  )
  put(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: PutChatbotSettingsDto,
  ) {
    const { expectedVersion, branchOpeningHours: _ignored, ...input } = body;
    void _ignored;
    return this.settings.put(
      tenantOf(user),
      user.userId,
      expectedVersion,
      input as AttentionSettingsInput,
    );
  }

  @Post('apply-to-all-tenants')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(['update', 'ChatbotSettingsAllBranches'])
  applyToAll(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ApplyToAllDto,
  ) {
    return this.settings.applyToAll(tenantOf(user), user.userId, {
      dryRun: body.dryRun === true,
      expectedVersion: body.expectedVersion,
    });
  }
}
