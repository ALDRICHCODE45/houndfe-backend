import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { PrismaEditorialAuthority } from '../infrastructure/prisma-editorial-authority';
import { PrismaEditorialContext } from '../infrastructure/prisma-editorial-context';
import { EditorialHttpFilter } from './editorial-http.filter';

@Controller('products/:productId/editorial/context')
@UseFilters(EditorialHttpFilter)
@UseGuards(JwtAuthGuard, TenantContextGuard)
export class EditorialContextController {
  constructor(
    private readonly authority: PrismaEditorialAuthority,
    private readonly context: PrismaEditorialContext,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async read(
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
    const scope = { actorId: user.userId, tenantId: user.tenantId, productId };
    const access = await this.authority.resolve({ ...scope }).catch(() => null);
    if (
      access?.activeMember !== true ||
      access.canRead !== true ||
      access.actorId !== scope.actorId ||
      access.tenantId !== scope.tenantId ||
      access.productId !== scope.productId
    )
      throw new ForbiddenException();
    return this.context.read(scope);
  }
}
