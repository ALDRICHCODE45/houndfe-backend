import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { CollectionReadService } from './collection-read.service';
import type { CollectionReadResponseDto } from './dto/customer-collection.dto';

/**
 * customer-collection / T3 (S5) — `GET /collections/:collectionId`, permission
 * `read:Sale` (contract v1 §1): the POST response shape of one «Cobrar todo»
 * (see `CollectionReadService` for the moment every number describes).
 * The receipt PDF route (`CollectionReceiptPdfController`) is registered in
 * PdfGenerationModule.
 */
@Controller('collections')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class CollectionsController {
  constructor(private readonly collections: CollectionReadService) {}

  @Get(':collectionId')
  @RequirePermissions(['read', 'Sale'])
  getCollection(
    @Param('collectionId', ParseUUIDPipe) collectionId: string,
  ): Promise<CollectionReadResponseDto> {
    return this.collections.getCollection(collectionId);
  }
}
