import {
  BadRequestException,
  ForbiddenException,
  Res,
  Controller,
  Header,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  EDITORIAL_DISCARD_WRITER,
  type EditorialDiscardWriter,
} from '../application/editorial-discard-writer';
import { createEditorialWriteRequestV2 } from '../application/editorial-write-request-v2';
import { PrismaEditorialAuthority } from '../infrastructure/prisma-editorial-authority';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import type { CatalogEditorialCore } from '../application/catalog-editorial-core';
import { EditorialHttpFilter } from './editorial-http.filter';
import { EDITORIAL_READER } from './editorial-read.controller';
import { idempotencyKey } from './idempotency-key';
import { EditorialHttpScope } from '../infrastructure/editorial-http-scope';

@Controller('products/:productId/editorial/draft')
@UseFilters(EditorialHttpFilter)
@UseGuards(JwtAuthGuard, TenantContextGuard)
export class EditorialWriteController {
  constructor(
    @Inject(EDITORIAL_READER)
    private readonly core: Pick<
      CatalogEditorialCore,
      'initialize' | 'save' | 'publish' | 'discard'
    >,
    private readonly scope: EditorialHttpScope,
    @Inject(EDITORIAL_DISCARD_WRITER)
    private readonly discardWriter: EditorialDiscardWriter,
    private readonly authority: PrismaEditorialAuthority,
  ) {}

  private async input(
    request: Request,
    productId: string,
    operation: 'initialize' | 'save' | 'transition',
  ) {
    const user = this.scope.principal(
      request.user as AuthenticatedUser | undefined,
    );
    const body: unknown = request.body;
    const initializing = operation === 'initialize';
    const keys = initializing
      ? ['expectedCycle']
      : operation === 'save'
        ? ['expectedCycle', 'expectedRevision', 'document']
        : ['expectedCycle', 'expectedRevision'];
    if (
      Object.keys(request.query).length ||
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(body, key))
    )
      throw new BadRequestException();
    const input = body as Record<string, unknown>;
    const positive = (value: unknown): value is number =>
      typeof value === 'number' && Number.isInteger(value) && value > 0;
    if (
      !(
        positive(input.expectedCycle) ||
        (initializing && input.expectedCycle === null)
      ) ||
      (!initializing && !positive(input.expectedRevision))
    )
      throw new BadRequestException();
    const key = idempotencyKey(request.headers['idempotency-key']);
    return {
      context: await this.scope.product(user, productId),
      input,
      key,
    };
  }

  @Post('initialize')
  @Header('Cache-Control', 'no-store')
  async initialize(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Req() request: Request,
  ) {
    const { context, input, key } = await this.input(
      request,
      productId,
      'initialize',
    );
    return this.core.initialize(context, {
      expectedCycle: input.expectedCycle as number | null,
      idempotencyKey: key,
    });
  }

  @Post('publish')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async publish(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Req() request: Request,
  ) {
    const { context, input, key } = await this.input(
      request,
      productId,
      'transition',
    );
    return this.core.publish(context, {
      expectedCycle: input.expectedCycle as number,
      expectedRevision: input.expectedRevision as number,
      idempotencyKey: key,
    });
  }

  @Post('discard')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async discard(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const user = this.scope.principal(
      request.user as AuthenticatedUser | undefined,
    );
    const context = await this.scope.product(user, productId);
    const access = await this.authority.resolve(context);
    if (
      access?.activeMember !== true ||
      access.canRead !== true ||
      access.canDiscard !== true ||
      access.actorId !== context.actorId ||
      access.tenantId !== context.tenantId ||
      access.productId !== context.productId
    )
      throw new ForbiddenException();
    if (Object.keys(request.query).length) throw new BadRequestException();
    const revisions: string[] = [];
    const keys: string[] = [];
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const name = request.rawHeaders[i].toLowerCase();
      if (
        [
          'editorial-care-confirmation',
          'editorial-contract-version',
          'editorial-adoption',
        ].includes(name)
      )
        throw new BadRequestException();
      if (name === 'editorial-vocabulary-revision')
        revisions.push(request.rawHeaders[i + 1]);
      if (name === 'idempotency-key') keys.push(request.rawHeaders[i + 1]);
    }
    if (revisions.length !== 1 || keys.length !== 1 || keys[0].includes(','))
      throw new BadRequestException();
    const key = idempotencyKey(keys[0]);
    let intent: ReturnType<typeof createEditorialWriteRequestV2>;
    try {
      intent = createEditorialWriteRequestV2(
        'discard',
        {
          vocabularyRevision: revisions[0],
          careConfirmation: null,
        },
        request.body,
      );
    } catch (error) {
      if (
        error instanceof TypeError &&
        error.message === 'Expected an editorial write request V2'
      )
        throw new BadRequestException();
      throw error;
    }
    const result = await this.discardWriter.discard(context, key, intent);
    response.status(result.status);
    for (const [name, value] of Object.entries(result.headers))
      response.setHeader(name, value);
    return result.body;
  }

  @Put()
  @Header('Cache-Control', 'no-store')
  async save(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Req() request: Request,
  ) {
    const { context, input, key } = await this.input(
      request,
      productId,
      'save',
    );
    return this.core.save(context, {
      expectedCycle: input.expectedCycle as number,
      expectedRevision: input.expectedRevision as number,
      document: input.document,
      idempotencyKey: key,
    });
  }
}
