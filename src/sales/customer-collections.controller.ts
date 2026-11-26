import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { CustomerCollectionService } from './customer-collection.service';
import {
  CreateCustomerCollectionDto,
  CustomerCollectionPreviewDto,
  type CollectionPreviewResponseDto,
  type CollectionResponseDto,
} from './dto/customer-collection.dto';

/**
 * customer-collection / T2 (S2, S3) — «Cobrar todo» (contract v1 §1).
 *
 * Lives in the sales module like `customers/:customerId/sales-monthly`: the
 * data and the writes are sales data, and a route in `CustomersController`
 * would make `CustomersModule` import `SalesModule`. Both routes require
 * `update:Sale` (Q4: any holder collects any sale of the customer).
 *
 * The apply route answers 201 for a new collection and 200 for an
 * idempotent replay of a completed one (contract §6).
 */
@Controller('customers/:customerId/collections')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class CustomerCollectionsController {
  constructor(private readonly collections: CustomerCollectionService) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['update', 'Sale'])
  preview(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: CustomerCollectionPreviewDto,
  ): Promise<CollectionPreviewResponseDto> {
    return this.collections.preview(customerId, dto);
  }

  @Post()
  @RequirePermissions(['update', 'Sale'])
  async apply(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: CreateCustomerCollectionDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CollectionResponseDto> {
    const key = idempotencyKey?.trim();
    if (!key) {
      throw new BadRequestException('IDEMPOTENCY_KEY_REQUIRED');
    }
    const result = await this.collections.apply(
      customerId,
      user.userId,
      dto,
      key,
    );
    res.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return result.body;
  }
}
