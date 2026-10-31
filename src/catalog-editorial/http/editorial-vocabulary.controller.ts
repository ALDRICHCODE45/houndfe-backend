import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { EditorialReaderAuthority } from '../infrastructure/editorial-reader-authority';
import { PrismaEditorialVocabularySnapshot } from '../infrastructure/prisma-editorial-vocabulary-snapshot';
import { EditorialHttpFilter } from './editorial-http.filter';
import { EditorialHttpScope } from '../infrastructure/editorial-http-scope';
import { createEditorialVocabularyHttpResponse } from './editorial-vocabulary-response';

@Controller('catalog-editorial/vocabulary')
@UseFilters(EditorialHttpFilter)
@UseGuards(JwtAuthGuard, TenantContextGuard)
export class EditorialVocabularyController {
  constructor(
    private readonly authority: EditorialReaderAuthority,
    private readonly vocabulary: PrismaEditorialVocabularySnapshot,
    private readonly scope: EditorialHttpScope,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async read(@Req() request: Request, @Res() response: Response) {
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
    const result = await createEditorialVocabularyHttpResponse(
      this.vocabulary,
      request.rawHeaders,
    );
    response.set(result.headers).status(result.statusCode).json(result.body);
  }
}
