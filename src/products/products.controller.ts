/**
 * ProductsController - HTTP Adapter (Driver Port).
 *
 * Translates HTTP requests to service calls.
 * Handles: Product CRUD + subresources (variants, lots, price lists, images).
 */
import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { CreateVariantDto, UpdateVariantDto } from './dto/variant.dto';
import { CreateLotDto, UpdateLotDto } from './dto/lot.dto';
import { UpdatePriceListDto } from './dto/price-list.dto';
import { CreateImageDto } from './dto/image.dto';
import {
  BulkUpsertVariantPricesDto,
  UpsertVariantPriceDto,
} from './dto/variant-price.dto';

@Controller('products')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  // ==================== Product CRUD ====================

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'Product'])
  create(@Body() dto: CreateProductDto) {
    return this.productsService.create(dto);
  }

  @Get()
  @RequirePermissions(['read', 'Product'])
  findAll() {
    return this.productsService.findAll();
  }

  @Get(':id')
  @RequirePermissions(['read', 'Product'])
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.productsService.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(['update', 'Product'])
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.productsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(['delete', 'Product'])
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.productsService.remove(id);
  }

  // ==================== Variants ====================

  @Post(':id/variants')
  @HttpCode(HttpStatus.CREATED)
  addVariant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateVariantDto,
  ) {
    return this.productsService.addVariant(id, dto);
  }

  @Get(':id/variants')
  getVariants(@Param('id', ParseUUIDPipe) id: string) {
    return this.productsService.getVariants(id);
  }

  @Patch(':id/variants/:variantId')
  updateVariant(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: UpdateVariantDto,
  ) {
    return this.productsService.updateVariant(id, variantId, dto);
  }

  @Delete(':id/variants/:variantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeVariant(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
  ) {
    return this.productsService.removeVariant(id, variantId);
  }

  @Get(':productId/variants/:variantId/prices')
  getVariantPrices(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
  ) {
    return this.productsService.getVariantPrices(productId, variantId);
  }

  @Put(':productId/variants/:variantId/prices/:priceListId')
  upsertVariantPrice(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Param('priceListId', ParseUUIDPipe) priceListId: string,
    @Body() dto: UpsertVariantPriceDto,
  ) {
    return this.productsService.upsertVariantPrice(
      productId,
      variantId,
      priceListId,
      dto,
    );
  }

  @Delete(':productId/variants/:variantId/prices/:priceListId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeVariantPrice(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Param('priceListId', ParseUUIDPipe) priceListId: string,
  ) {
    return this.productsService.removeVariantPrice(
      productId,
      variantId,
      priceListId,
    );
  }

  @Put(':productId/variants/:variantId/prices')
  bulkUpsertVariantPrices(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: BulkUpsertVariantPricesDto,
  ) {
    return this.productsService.bulkUpsertVariantPrices(
      productId,
      variantId,
      dto,
    );
  }

  // ==================== Lots ====================

  @Post(':id/lots')
  @HttpCode(HttpStatus.CREATED)
  addLot(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateLotDto) {
    return this.productsService.addLot(id, dto);
  }

  @Get(':id/lots')
  getLots(@Param('id', ParseUUIDPipe) id: string) {
    return this.productsService.getLots(id);
  }

  @Patch(':id/lots/:lotId')
  updateLot(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @Body() dto: UpdateLotDto,
  ) {
    return this.productsService.updateLot(id, lotId, dto);
  }

  @Delete(':id/lots/:lotId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeLot(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lotId', ParseUUIDPipe) lotId: string,
  ) {
    return this.productsService.removeLot(id, lotId);
  }

  // ==================== Price Lists ====================

  @Get(':id/price-lists')
  getPriceLists(@Param('id', ParseUUIDPipe) id: string) {
    return this.productsService.getPriceLists(id);
  }

  @Patch(':id/price-lists/:priceListId')
  updatePriceList(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('priceListId', ParseUUIDPipe) priceListId: string,
    @Body() dto: UpdatePriceListDto,
  ) {
    return this.productsService.updatePriceList(id, priceListId, dto);
  }

  // ==================== Images ====================

  /**
   * POST /products/:id/images - Upload product image (multipart)
   * Spec: R6 (S15, S16) - Upload product image via file storage
   */
  @Post(':id/images/upload')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['update', 'Product'])
  @UseInterceptors(FileInterceptor('file'))
  async uploadProductImage(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.productsService.uploadProductImage(id, file, user.userId);
  }

  /**
   * POST /products/:id/variants/:variantId/images - Upload variant image (multipart)
   * Spec: R7 (S18, S19) - Upload variant image via file storage
   */
  @Post(':id/variants/:variantId/images/upload')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['update', 'Product'])
  @UseInterceptors(FileInterceptor('file'))
  async uploadVariantImage(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.productsService.uploadVariantImage(
      id,
      variantId,
      file,
      user.userId,
    );
  }

  @Post(':id/images')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['update', 'Product'])
  addImage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateImageDto,
  ) {
    return this.productsService.addImage(id, dto);
  }

  @Get(':id/images')
  @RequirePermissions(['read', 'Product'])
  getImages(@Param('id', ParseUUIDPipe) id: string) {
    return this.productsService.getImages(id);
  }

  @Patch(':id/images/:imageId/main')
  @RequirePermissions(['update', 'Product'])
  setMainImage(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
  ) {
    return this.productsService.setMainImage(id, imageId);
  }

  @Delete(':id/images/:imageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(['update', 'Product'])
  removeImage(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
  ) {
    return this.productsService.removeImage(id, imageId);
  }
}
