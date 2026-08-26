/**
 * AdminPaymentMethodController — custom-payment-methods / WU1.
 *
 * HTTP adapter for the `PaymentMethod` admin CRUD. Mirrors
 * `AdminPaymentDetailController`: `@UseGuards(JwtAuthGuard,
 * TenantContextGuard, PermissionsGuard)` at the class level,
 * `@RequirePermissions([action, 'PaymentMethod'])` per route.
 *
 * ROUTES:
 *   POST   /admin/payment-methods           → create:PaymentMethod
 *   GET    /admin/payment-methods           → read:PaymentMethod
 *   GET    /admin/payment-methods/:id       → read:PaymentMethod
 *   PATCH  /admin/payment-methods/:id       → update:PaymentMethod
 *   DELETE /admin/payment-methods/:id       → delete:PaymentMethod (logical)
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
import { AdminPaymentMethodService } from './admin-payment-method.service';
import { CreatePaymentMethodDto } from './dto/create-payment-method.dto';
import { UpdatePaymentMethodDto } from './dto/update-payment-method.dto';

@Controller('admin/payment-methods')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class AdminPaymentMethodController {
  constructor(
    private readonly adminPaymentMethodService: AdminPaymentMethodService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'PaymentMethod'])
  create(@Body() dto: CreatePaymentMethodDto) {
    return this.adminPaymentMethodService.create(dto);
  }

  @Get()
  @RequirePermissions(['read', 'PaymentMethod'])
  findAll() {
    return this.adminPaymentMethodService.findAll();
  }

  @Get(':id')
  @RequirePermissions(['read', 'PaymentMethod'])
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminPaymentMethodService.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(['update', 'PaymentMethod'])
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePaymentMethodDto,
  ) {
    return this.adminPaymentMethodService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(['delete', 'PaymentMethod'])
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminPaymentMethodService.delete(id);
  }
}