import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  Param,
  ParseUUIDPipe,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import type { CatalogEditorialCore } from '../application/catalog-editorial-core';
import { EditorialHttpFilter } from './editorial-http.filter';

export const EDITORIAL_READER = Symbol('EDITORIAL_READER');

@Controller('products/:productId/editorial')
@UseFilters(EditorialHttpFilter)
@UseGuards(JwtAuthGuard, TenantContextGuard)
export class EditorialReadController {
  constructor(
    @Inject(EDITORIAL_READER)
    private readonly reader: Pick<CatalogEditorialCore, 'read'>,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  read(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Req() request: Request,
  ) {
    const user = request.user as AuthenticatedUser | undefined;
    if (!user?.userId?.trim() || !user.tenantId?.trim())
      throw new ForbiddenException();
    const body: unknown = request.body;
    if (
      Object.keys(request.query).length ||
      (body !== undefined &&
        (!body ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          Object.keys(body).length))
    )
      throw new BadRequestException();
    return this.reader.read({
      actorId: user.userId,
      tenantId: user.tenantId,
      productId,
    });
  }
}
