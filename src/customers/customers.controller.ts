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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { CustomersService } from './customers.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CreateAddressDto, UpdateAddressDto } from './dto/address.dto';

@Controller('customers')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  // ==================== Customer CRUD ====================

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'Customer'])
  create(@Body() dto: CreateCustomerDto) {
    return this.customersService.create(dto);
  }

  @Get()
  @RequirePermissions(['read', 'Customer'])
  findAll() {
    return this.customersService.findAll();
  }

  @Get(':id')
  @RequirePermissions(['read', 'Customer'])
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.customersService.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(['update', 'Customer'])
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.customersService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(['delete', 'Customer'])
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.customersService.remove(id);
  }

  // ==================== Addresses ====================

  @Post(':id/addresses')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['update', 'Customer'])
  addAddress(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAddressDto,
  ) {
    return this.customersService.addAddress(id, dto);
  }

  @Get(':id/addresses')
  @RequirePermissions(['read', 'Customer'])
  getAddresses(@Param('id', ParseUUIDPipe) id: string) {
    return this.customersService.getAddresses(id);
  }

  @Patch(':id/addresses/:addressId')
  @RequirePermissions(['update', 'Customer'])
  updateAddress(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('addressId', ParseUUIDPipe) addressId: string,
    @Body() dto: UpdateAddressDto,
  ) {
    return this.customersService.updateAddress(id, addressId, dto);
  }

  @Delete(':id/addresses/:addressId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(['update', 'Customer'])
  removeAddress(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('addressId', ParseUUIDPipe) addressId: string,
  ) {
    return this.customersService.removeAddress(id, addressId);
  }
}
