/**
 * PromotionsController - HTTP Adapter (Driver Port).
 *
 * Translates HTTP requests to PromotionsService calls.
 * Handles: Promotion CRUD + manual end endpoint.
 *
 * All routes protected by JWT + CASL permissions (Promotion subject).
 */
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { PromotionsService } from './promotions.service';
import { CreatePromotionDto } from './dto/create-promotion.dto';
import { UpdatePromotionDto } from './dto/update-promotion.dto';
import { PromotionQueryDto } from './dto/promotion-query.dto';

@Controller('promotions')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class PromotionsController {
  constructor(private readonly promotionsService: PromotionsService) {}

  // ==================== CRUD ====================

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'Promotion'])
  create(@Body() dto: CreatePromotionDto) {
    return this.promotionsService.create(dto);
  }

  @Get()
  @RequirePermissions(['read', 'Promotion'])
  findAll(@Query() query: PromotionQueryDto) {
    return this.promotionsService.findAll(query);
  }

  @Get(':id')
  @RequirePermissions(['read', 'Promotion'])
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.promotionsService.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(['update', 'Promotion'])
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePromotionDto,
  ) {
    return this.promotionsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(['delete', 'Promotion'])
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.promotionsService.remove(id);
  }

  // ==================== End Promotion ====================

  @Patch(':id/end')
  @RequirePermissions(['update', 'Promotion'])
  endPromotion(@Param('id', ParseUUIDPipe) id: string) {
    return this.promotionsService.endPromotion(id);
  }
}
