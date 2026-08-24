/**
 * AdminPaymentDetailController — Q1 / WU1.
 *
 * HTTP adapter for the `PaymentDetail` admin CRUD. Mirrors
 * `AdminRoleController`: `@UseGuards(JwtAuthGuard, TenantContextGuard,
 * PermissionsGuard)` at the class level, `@RequirePermissions([action,
 * 'PaymentDetail'])` per route.
 *
 * ROUTES:
 *   POST   /admin/payment-details           → create:PaymentDetail
 *   GET    /admin/payment-details           → read:PaymentDetail
 *   GET    /admin/payment-details/:id       → read:PaymentDetail
 *   PATCH  /admin/payment-details/:id       → update:PaymentDetail
 *   DELETE /admin/payment-details/:id       → delete:PaymentDetail (logical)
 */
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { AdminPaymentDetailService } from './admin-payment-detail.service';
import { CreatePaymentDetailDto } from './dto/create-payment-detail.dto';
import { UpdatePaymentDetailDto } from './dto/update-payment-detail.dto';

@Controller('admin/payment-details')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class AdminPaymentDetailController {
  constructor(
    private readonly adminPaymentDetailService: AdminPaymentDetailService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'PaymentDetail'])
  create(@Body() dto: CreatePaymentDetailDto) {
    return this.adminPaymentDetailService.create(dto);
  }

  @Get()
  @RequirePermissions(['read', 'PaymentDetail'])
  findAll() {
    return this.adminPaymentDetailService.findAll();
  }

  @Get(':id')
  @RequirePermissions(['read', 'PaymentDetail'])
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminPaymentDetailService.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(['update', 'PaymentDetail'])
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePaymentDetailDto,
  ) {
    return this.adminPaymentDetailService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(['delete', 'PaymentDetail'])
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminPaymentDetailService.delete(id);
  }
}
