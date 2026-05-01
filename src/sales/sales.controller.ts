/**
 * SalesController - HTTP Adapter (Driver Port) for POS Sales.
 *
 * Translates HTTP requests to service calls.
 * Handles: draft creation, item management (add, update quantity, clear), draft deletion.
 */
import {
  Controller,
  Post,
  Patch,
  Delete,
  Get,
  Body,
  Param,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { SalesService } from './sales.service';
import { AddItemDto } from './dto/add-item.dto';
import { UpdateItemQuantityDto } from './dto/update-item-quantity.dto';
import { OverrideItemPriceDto } from './dto/override-item-price.dto';
import { ApplyItemDiscountDto } from './dto/apply-item-discount.dto';

@Controller('sales/drafts')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SalesController {
  constructor(private readonly salesService: SalesService) {}

  /**
   * POST /sales/drafts — Open a new draft sale
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'Sale'])
  openDraft(@CurrentUser() user: AuthenticatedUser) {
    return this.salesService.openDraft(user.userId);
  }

  /**
   * GET /sales/drafts — Get all drafts for the authenticated user
   */
  @Get()
  @RequirePermissions(['read', 'Sale'])
  getUserDrafts(@CurrentUser() user: AuthenticatedUser) {
    return this.salesService.getUserDrafts(user.userId);
  }

  /**
   * POST /sales/drafts/:id/items — Add item to a draft
   */
  @Post(':id/items')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'Sale'])
  addItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddItemDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.salesService.addItem(id, user.userId, dto);
  }

  /**
   * PATCH /sales/drafts/:id/items/:itemId — Update item quantity
   */
  @Patch(':id/items/:itemId')
  @RequirePermissions(['update', 'Sale'])
  updateItemQuantity(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateItemQuantityDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.salesService.updateItemQuantity(id, user.userId, itemId, dto);
  }

  /**
   * DELETE /sales/drafts/:id/items — Clear all items from a draft
   */
  @Delete(':id/items')
  @RequirePermissions(['update', 'Sale'])
  clearItems(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.salesService.clearItems(id, user.userId);
  }

  @Delete(':id/items/:itemId')
  @RequirePermissions(['update', 'Sale'])
  removeItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.salesService.removeItem(id, user.userId, itemId);
  }

  /**
   * DELETE /sales/drafts/:id — Delete a draft sale
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(['delete', 'Sale'])
  deleteDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.salesService.deleteDraft(id, user.userId);
  }

  @Get(':id/items/:itemId/available-prices')
  @RequirePermissions(['update', 'Sale'])
  getAvailablePrices(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.salesService.getAvailablePrices(id, itemId, user.userId);
  }

  @Patch(':id/items/:itemId/price')
  @RequirePermissions(['update', 'Sale'])
  overrideItemPrice(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: OverrideItemPriceDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.salesService.overrideItemPrice(id, itemId, dto, user.userId);
  }

  @Patch(':id/items/:itemId/discount')
  @RequirePermissions(['update', 'Sale'])
  applyItemDiscount(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: ApplyItemDiscountDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.salesService.applyItemDiscount(id, itemId, dto, user.userId);
  }

  @Delete(':id/items/:itemId/discount')
  @RequirePermissions(['update', 'Sale'])
  removeItemDiscount(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.salesService.removeItemDiscount(id, itemId, user.userId);
  }

  @Patch(':id/discount')
  @RequirePermissions(['update', 'Sale'])
  applyGlobalDiscount(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApplyItemDiscountDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.salesService.applyGlobalDiscount(id, dto, user.userId);
  }

  @Delete(':id/discount')
  @RequirePermissions(['update', 'Sale'])
  removeGlobalDiscount(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.salesService.removeGlobalDiscount(id, user.userId);
  }
}
