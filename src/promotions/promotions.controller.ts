/**
 * PromotionsController - HTTP Adapter (Driver Port).
 *
 * Translates HTTP requests to PromotionsService calls.
 * Handles: Promotion CRUD + manual end + batch-delete endpoint.
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
import {
  BatchDeleteDto,
  BatchDeleteGuard,
  BatchDeleteOrchestrator,
} from '../shared/batch-delete';

@Controller('promotions')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class PromotionsController {
  constructor(
    private readonly promotionsService: PromotionsService,
    private readonly batchDeleteOrchestrator: BatchDeleteOrchestrator,
  ) {}

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

  // ==================== Batch Delete ====================

  /**
   * `POST /promotions/batch-delete`
   *
   * All-or-nothing deletion of multiple promotions. Pre-flight
   * validation rejects the whole batch if any ID is referenced by a
   * sale record or does not exist in the current tenant — see
   * `PromotionsService.validateForBatchDeletion` for the rules.
   *
   * Permission enforcement:
   *  - `@RequirePermissions(['batch_delete', 'Promotion'])` is read by
   *    both the standard `PermissionsGuard` (chain) and the dedicated
   *    `BatchDeleteGuard` (R10: manage does NOT imply batch_delete).
   */
  @Post('batch-delete')
  @HttpCode(HttpStatus.OK)
  @UseGuards(BatchDeleteGuard)
  @RequirePermissions(['batch_delete', 'Promotion'])
  async batchDelete(@Body() dto: BatchDeleteDto): Promise<{ deleted: number }> {
    return this.batchDeleteOrchestrator.execute(dto.ids);
  }
}
