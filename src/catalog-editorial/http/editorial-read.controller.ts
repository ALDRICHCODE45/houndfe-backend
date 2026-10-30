import {
  BadRequestException,
  Controller,
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
import { EditorialHttpScope } from '../infrastructure/editorial-http-scope';

export const EDITORIAL_READER = Symbol('EDITORIAL_READER');

@Controller('products/:productId/editorial')
@UseFilters(EditorialHttpFilter)
@UseGuards(JwtAuthGuard, TenantContextGuard)
export class EditorialReadController {
  constructor(
    @Inject(EDITORIAL_READER)
    private readonly reader: Pick<CatalogEditorialCore, 'read'>,
    private readonly scope: EditorialHttpScope,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async read(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Req() request: Request,
  ) {
    const user = this.scope.principal(
      request.user as AuthenticatedUser | undefined,
    );
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
    return this.reader.read(await this.scope.product(user, productId));
  }
}
