/**
 * QuotationsController — HTTP driver for the Quotations bounded context.
 *
 * WU3 surface (additive on top of WU2):
 *   - `POST   /quotations/drafts/:id/items`                       — addItem
 *   - `PATCH  /quotations/drafts/:id/items/:itemId/quantity`      — updateItemQuantity
 *   - `DELETE /quotations/drafts/:id/items/:itemId`               — removeItem
 *   - `PATCH  /quotations/drafts/:id/items/:itemId/price`         — overrideItemPrice
 *   - `PUT    /quotations/drafts/:id/manual-promotions/:promoId`  — applyManualPromotion
 *   - `DELETE /quotations/drafts/:id/manual-promotions/:promoId`  — removeManualPromotion
 *   - `PATCH  /quotations/drafts/:id/expiry`                      — setExpiry
 *   - `POST   /quotations/drafts/:id/cancel`                      — cancel
 *   - `POST   /quotations/drafts/:id/promotions/:promoId/veto`    — vetoPromotion
 *   - `DELETE /quotations/drafts/:id/promotions/:promoId/veto`    — optInPromotion
 *
 * All routes are guarded by the standard triple
 * (JWT + tenant-context + permissions). The permission strings pair
 * an action with the `Quotation` subject — registered in
 * `PERMISSION_REGISTRY` (T017).
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';

import { QuotationsService } from '../application/quotations.service';
import { CreateQuotationDto } from '../dto/create-quotation.dto';
import { AssignCustomerDto } from '../dto/assign-customer.dto';
import { SetPriceListDto } from '../dto/set-price-list.dto';
import { QuotationQueryDto } from '../dto/quotation-query.dto';
import { AddQuotationItemDto } from '../dto/add-quotation-item.dto';
import { UpdateQuotationItemQuantityDto } from '../dto/update-quotation-item-quantity.dto';
import { OverrideQuotationItemPriceDto } from '../dto/override-quotation-item-price.dto';
import { SetQuotationExpiryDto } from '../dto/set-quotation-expiry.dto';
import { CancelQuotationDto } from '../dto/cancel-quotation.dto';

@Controller('quotations')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class QuotationsController {
  constructor(private readonly quotationsService: QuotationsService) {}

  /**
   * `POST /quotations/drafts` — Open a new DRAFT quotation.
   *
   * Body is optional (`CreateQuotationDto.customerId?` /
   * `globalPriceListId?`). The service auto-seeds
   * `globalPriceListId` from the customer unless the cashier
   * passes an explicit list (T015).
   */
  @Post('drafts')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'Quotation'])
  openDraft(
    @Body() dto: CreateQuotationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.quotationsService.openDraft(user.userId, dto);
  }

  /**
   * `GET /quotations` — paginated list for the current tenant.
   *
   * The repository enforces tenant scoping; the service applies the
   * lazy EXPIRED transition. There is no `sellerUserId` filter at the
   * controller level — quotations are visible to every sales-rep in
   * the tenant (mirrors the sale-list endpoint conventions).
   */
  @Get()
  @RequirePermissions(['read', 'Quotation'])
  list(@Query() query: QuotationQueryDto) {
    return this.quotationsService.findAll(query);
  }

  /**
   * `GET /quotations/:id` — full single-quotation detail with items,
   * promotions, customer, and totals. Triggers the lazy EXPIRED
   * transition on read.
   */
  @Get(':id')
  @RequirePermissions(['read', 'Quotation'])
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.quotationsService.findOne(id);
  }

  /**
   * `PUT /quotations/drafts/:id/customer` — assign a customer to a
   * draft. Auto-seeds the price list from the customer's default
   * unless the cashier has set one explicitly (T015).
   */
  @Put('drafts/:id/customer')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'Quotation'])
  assignCustomer(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AssignCustomerDto,
  ) {
    return this.quotationsService.assignCustomer(id, dto);
  }

  /**
   * `PUT /quotations/drafts/:id/price-list` — cashier-explicit
   * price-list binding. Mirrors the sale-level endpoint
   * (`SalesController.setSalePriceList`) so the FE can reuse the
   * `globalPriceListId` field shape.
   */
  @Put('drafts/:id/price-list')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'Quotation'])
  setPriceList(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SetPriceListDto,
  ) {
    return this.quotationsService.setPriceList(id, dto);
  }

  // ── Items ──────────────────────────────────────────────────────────

  /**
   * `POST /quotations/drafts/:id/items` — add an item to a DRAFT
   * quotation. The service resolves the product/variant via
   * `ProductsService.getProductInfoForSale` and the recompute pipeline
   * re-resolves prices when a price list is bound. No stock check.
   */
  @Post('drafts/:id/items')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['update', 'Quotation'])
  addItem(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AddQuotationItemDto,
  ) {
    return this.quotationsService.addItem(id, dto);
  }

  /**
   * `PATCH /quotations/drafts/:id/items/:itemId/quantity` — update
   * the quantity of an existing item. Quantity 0 is rejected by the
   * entity's `updateItemQuantity` (→ 400 via `InvalidArgumentError`).
   */
  @Patch('drafts/:id/items/:itemId/quantity')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'Quotation'])
  updateItemQuantity(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() dto: UpdateQuotationItemQuantityDto,
  ) {
    return this.quotationsService.updateItemQuantity(id, itemId, dto);
  }

  /**
   * `DELETE /quotations/drafts/:id/items/:itemId` — remove an item
   * from a DRAFT quotation. Triggers a recompute so the remaining
   * items re-evaluate against the new state.
   */
  @Delete('drafts/:id/items/:itemId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'Quotation'])
  removeItem(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
  ) {
    return this.quotationsService.removeItem(id, itemId);
  }

  /**
   * `PATCH /quotations/drafts/:id/items/:itemId/price` — override the
   * unit price of an existing item. Sets `priceSource = 'CUSTOM'` so
   * subsequent recomputes skip the line (sticky). The recompute
   * re-applies any eligible AUTO promo on the NEW baseline.
   */
  @Patch('drafts/:id/items/:itemId/price')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'Quotation'])
  overrideItemPrice(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() dto: OverrideQuotationItemPriceDto,
  ) {
    return this.quotationsService.overrideItemPrice(id, itemId, dto);
  }

  // ── Manual promotions ──────────────────────────────────────────────

  /**
   * `PUT /quotations/drafts/:id/manual-promotions/:promoId` — opt a
   * MANUAL promotion in. Idempotent; cross-clears the veto set when
   * the same id was previously vetoed (reactivation path).
   */
  @Put('drafts/:id/manual-promotions/:promoId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'Quotation'])
  applyManualPromotion(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('promoId', new ParseUUIDPipe()) promoId: string,
  ) {
    return this.quotationsService.applyManualPromotion(id, promoId);
  }

  /**
   * `DELETE /quotations/drafts/:id/manual-promotions/:promoId` —
   * remove a MANUAL opt-in. Idempotent.
   */
  @Delete('drafts/:id/manual-promotions/:promoId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'Quotation'])
  removeManualPromotion(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('promoId', new ParseUUIDPipe()) promoId: string,
  ) {
    return this.quotationsService.removeManualPromotion(id, promoId);
  }

  // ── Automatic promotions (veto / opt-in) ──────────────────────────

  /**
   * `POST /quotations/drafts/:id/promotions/:promoId/veto` — remove an
   * auto-applied AUTOMATIC promotion from a DRAFT quotation (veto).
   * The veto persists across recomputes.
   */
  @Post('drafts/:id/promotions/:promoId/veto')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'Quotation'])
  vetoPromotion(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('promoId', new ParseUUIDPipe()) promoId: string,
  ) {
    return this.quotationsService.vetoPromotion(id, promoId);
  }

  /**
   * `DELETE /quotations/drafts/:id/promotions/:promoId/veto` —
   * re-opt a previously vetoed AUTOMATIC promotion (reactivation).
   */
  @Delete('drafts/:id/promotions/:promoId/veto')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'Quotation'])
  optInPromotion(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('promoId', new ParseUUIDPipe()) promoId: string,
  ) {
    return this.quotationsService.optInPromotion(id, promoId);
  }

  // ── Expiry + cancel ────────────────────────────────────────────────

  /**
   * `PATCH /quotations/drafts/:id/expiry` — set or clear the optional
   * expiry date. The lazy EXPIRED transition happens on read.
   */
  @Patch('drafts/:id/expiry')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'Quotation'])
  setExpiry(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SetQuotationExpiryDto,
  ) {
    return this.quotationsService.setExpiry(id, dto);
  }

  /**
   * `POST /quotations/drafts/:id/cancel` — cancel a quotation with a
   * reason. Idempotent on CANCELLED.
   */
  @Post('drafts/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'Quotation'])
  cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CancelQuotationDto,
  ) {
    return this.quotationsService.cancel(id, dto);
  }
}
