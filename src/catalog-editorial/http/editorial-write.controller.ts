import {
  BadRequestException,
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
import type { Request } from 'express';
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
  ) {
    const { context, input, key } = await this.input(
      request,
      productId,
      'transition',
    );
    return this.core.discard(context, {
      expectedCycle: input.expectedCycle as number,
      expectedRevision: input.expectedRevision as number,
      idempotencyKey: key,
    });
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
