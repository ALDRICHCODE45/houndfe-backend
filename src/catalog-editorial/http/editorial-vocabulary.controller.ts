import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { EditorialReaderAuthority } from '../infrastructure/editorial-reader-authority';
import { PrismaEditorialVocabulary } from '../infrastructure/prisma-editorial-vocabulary';
import { EditorialHttpFilter } from './editorial-http.filter';
import { EditorialHttpScope } from '../infrastructure/editorial-http-scope';

@Controller('catalog-editorial/vocabulary')
@UseFilters(EditorialHttpFilter)
@UseGuards(JwtAuthGuard, TenantContextGuard)
export class EditorialVocabularyController {
  constructor(
    private readonly authority: EditorialReaderAuthority,
    private readonly vocabulary: PrismaEditorialVocabulary,
    private readonly scope: EditorialHttpScope,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async read(@Req() request: Request) {
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
    if (!(await this.authority.permits(user.userId, user.tenantId)))
      throw new ForbiddenException();
    return this.vocabulary.read();
  }
}
