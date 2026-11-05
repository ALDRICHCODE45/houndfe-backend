import {
  BadRequestException,
  Controller,
  Get,
  ForbiddenException,
  Res,
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
import type { Request, Response } from 'express';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import {
  EDITORIAL_DOCUMENT_READER,
  type EditorialDocumentReader,
} from '../application/editorial-document-reader';
import {
  EDITORIAL_READINESS_READER,
  type EditorialReadinessReader,
} from '../application/editorial-readiness-reader';
import type { EditorialContext } from '../application/catalog-editorial-core';
import { PrismaEditorialAuthority } from '../infrastructure/prisma-editorial-authority';
import { EditorialHttpFilter } from './editorial-http.filter';
import { EditorialHttpScope } from '../infrastructure/editorial-http-scope';

@Controller('products/:productId/editorial')
@UseFilters(EditorialHttpFilter)
@UseGuards(JwtAuthGuard, TenantContextGuard)
export class EditorialReadController {
  constructor(
    @Inject(EDITORIAL_DOCUMENT_READER)
    private readonly reader: EditorialDocumentReader,
    @Inject(EDITORIAL_READINESS_READER)
    private readonly readiness: EditorialReadinessReader,
    private readonly scope: EditorialHttpScope,
    private readonly authority: PrismaEditorialAuthority,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async read(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { scope, revision } = await this.admit(productId, request);
    const result = await this.reader.read(scope, revision);
    response.setHeader('Editorial-Contract-Version', '2');
    response.setHeader(
      'Editorial-Vocabulary-Revision',
      result.vocabularyRevision,
    );
    return result;
  }

  /** What blocks publishing the SAVED Draft; read-only, same rules as the read. */
  @Get('draft/readiness')
  @Header('Cache-Control', 'no-store')
  async draftReadiness(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { scope, revision } = await this.admit(productId, request);
    const result = await this.readiness.read(scope, revision);
    response.setHeader('Editorial-Contract-Version', '2');
    response.setHeader(
      'Editorial-Vocabulary-Revision',
      result.vocabularyRevision,
    );
    return result;
  }

  /** Current read authority, then closed request admission (no query/body/write headers). */
  private async admit(
    productId: string,
    request: Request,
  ): Promise<{ scope: EditorialContext; revision: string }> {
    const user = this.scope.principal(
      request.user as AuthenticatedUser | undefined,
    );
    const scope = await this.scope.product(user, productId);
    const access = await this.authority.resolve(scope).catch(() => null);
    if (
      access?.activeMember !== true ||
      access.canRead !== true ||
      access.actorId !== scope.actorId ||
      access.tenantId !== scope.tenantId ||
      access.productId !== scope.productId
    )
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
    const revisions: string[] = [];
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const name = request.rawHeaders[i].toLowerCase();
      if (
        [
          'idempotency-key',
          'editorial-care-confirmation',
          'editorial-contract-version',
          'editorial-adoption',
        ].includes(name)
      )
        throw new BadRequestException();
      if (name === 'editorial-vocabulary-revision')
        revisions.push(request.rawHeaders[i + 1]);
    }
    if (
      revisions.length !== 1 ||
      revisions[0].length !== 75 ||
      !/^ev2-sha256-[0-9a-f]{64}$/.test(revisions[0])
    )
      throw new BadRequestException();
    return { scope, revision: revisions[0] };
  }
}
