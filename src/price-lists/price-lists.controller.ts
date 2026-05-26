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
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { PriceListsService } from './price-lists.service';
import { CreatePriceListDto } from './dto/create-price-list.dto';
import { UpdatePriceListDto } from './dto/update-price-list.dto';

@Controller('price-lists')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class PriceListsController {
  constructor(private readonly priceListsService: PriceListsService) {}

  @Get()
  @RequirePermissions(['read', 'GlobalPriceList'])
  findAll() {
    return this.priceListsService.findAll();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'GlobalPriceList'])
  create(@Body() dto: CreatePriceListDto) {
    return this.priceListsService.create(dto);
  }

  @Patch(':id')
  @RequirePermissions(['update', 'GlobalPriceList'])
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePriceListDto,
  ) {
    return this.priceListsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(['delete', 'GlobalPriceList'])
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.priceListsService.remove(id);
  }
}
