import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Header,
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

@Controller('products/:productId/editorial/draft')
@UseFilters(EditorialHttpFilter)
@UseGuards(JwtAuthGuard, TenantContextGuard)
export class EditorialWriteController {
  constructor(
    @Inject(EDITORIAL_READER)
    private readonly core: Pick<CatalogEditorialCore, 'initialize' | 'save'>,
  ) {}

  private input(request: Request, productId: string, saving: boolean) {
    const user = request.user as AuthenticatedUser | undefined;
    if (!user?.userId?.trim() || !user.tenantId?.trim())
      throw new ForbiddenException();
    const body: unknown = request.body;
    const keys = saving
      ? ['expectedCycle', 'expectedRevision', 'document']
      : ['expectedCycle'];
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
        (!saving && input.expectedCycle === null)
      ) ||
      (saving && !positive(input.expectedRevision))
    )
      throw new BadRequestException();
    return {
      context: { actorId: user.userId, tenantId: user.tenantId, productId },
      input,
      key: idempotencyKey(request.headers['idempotency-key']),
    };
  }

  @Post('initialize')
  @Header('Cache-Control', 'no-store')
  initialize(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Req() request: Request,
  ) {
    const { context, input, key } = this.input(request, productId, false);
    return this.core.initialize(context, {
      expectedCycle: input.expectedCycle as number | null,
      idempotencyKey: key,
    });
  }

  @Put()
  @Header('Cache-Control', 'no-store')
  save(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Req() request: Request,
  ) {
    const { context, input, key } = this.input(request, productId, true);
    return this.core.save(context, {
      expectedCycle: input.expectedCycle as number,
      expectedRevision: input.expectedRevision as number,
      document: input.document,
      idempotencyKey: key,
    });
  }
}
