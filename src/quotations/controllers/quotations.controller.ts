/**
 * QuotationsController — HTTP driver for the Quotations bounded context.
 *
 * WU2 surface:
 *   - `POST  /quotations/drafts`              — create a draft.
 *   - `GET   /quotations`                     — paginated list.
 *   - `GET   /quotations/:id`                 — single-quotation detail.
 *   - `PUT   /quotations/drafts/:id/customer` — assign customer.
 *   - `PUT   /quotations/drafts/:id/price-list` — set price list.
 *
 * WU3 will add item/promotion/expiry/send-cancel endpoints on this same
 * controller — kept out of scope here per the WU2 boundary.
 *
 * All routes are guarded by the standard triple
 * (JWT + tenant-context + permissions). The permission strings pair
 * an action with the `Quotation` subject — registered in
 * `PERMISSION_REGISTRY` (T017).
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
}
