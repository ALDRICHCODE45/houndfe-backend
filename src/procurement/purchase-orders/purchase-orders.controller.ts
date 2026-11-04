import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Req,
  Res,
  Header,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import { PurchaseOrderCommands } from './po-commands';
import { PurchaseOrderQueries } from './po-queries';
import { PurchaseOrderHttpFilter } from './po-http.filter';
import {
  parseOrderInput,
  parsePurchaseOrderCancel,
  parsePurchaseOrderConfirm,
  parsePurchaseOrderId,
  parsePurchaseOrderIdempotencyKey,
  parsePurchaseOrderReplace,
  parsePurchaseOrderDelete,
  parsePurchaseOrderListQuery,
  PurchaseOrderContractError,
} from './po-contract';

function noQuery(request: Request): void {
  if (Object.keys(request.query).length)
    throw new PurchaseOrderContractError('MALFORMED');
}
function noBody(request: Request): void {
  if (
    request.headers['transfer-encoding'] !== undefined ||
    Number(request.headers['content-length'] ?? 0) > 0
  )
    throw new PurchaseOrderContractError('MALFORMED');
}
function jsonBody(request: Request): void {
  if (!request.is('application/json'))
    throw new PurchaseOrderContractError('MALFORMED');
}

@Controller('procurement/purchase-orders')
@UseFilters(PurchaseOrderHttpFilter)
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class PurchaseOrdersController {
  constructor(
    private readonly commands: PurchaseOrderCommands,
    private readonly queries: PurchaseOrderQueries,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(['read', 'ProcurementPurchaseOrder'])
  list(@Req() request: Request) {
    noBody(request);
    parsePurchaseOrderListQuery(request.query);
    return this.queries.listDrafts(request.query);
  }

  @Get(':orderId')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(['read', 'ProcurementPurchaseOrder'])
  detail(@Req() request: Request) {
    noQuery(request);
    noBody(request);
    return this.queries.getDraft(parsePurchaseOrderId(request.params.orderId));
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(
    ['create', 'ProcurementPurchaseOrder'],
    ['read', 'ProcurementSupplier'],
    ['read', 'Product'],
  )
  async create(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    noQuery(request);
    jsonBody(request);
    const key = parsePurchaseOrderIdempotencyKey(request.rawHeaders);
    const body = parseOrderInput(request.body);
    const result = await this.commands.createDraft(key, body);
    response.status(result.statusCode);
    return result.body;
  }

  @Put(':orderId/draft')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(
    ['read', 'ProcurementPurchaseOrder'],
    ['update', 'ProcurementPurchaseOrder'],
    ['read', 'ProcurementSupplier'],
    ['read', 'Product'],
  )
  async replace(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    noQuery(request);
    jsonBody(request);
    const id = parsePurchaseOrderId(request.params.orderId);
    const key = parsePurchaseOrderIdempotencyKey(request.rawHeaders);
    const body = parsePurchaseOrderReplace(request.body);
    const result = await this.commands.replaceDraft(id, key, body);
    response.status(result.statusCode);
    return result.body;
  }

  @Delete(':orderId')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(
    ['read', 'ProcurementPurchaseOrder'],
    ['delete', 'ProcurementPurchaseOrder'],
  )
  async delete(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    noQuery(request);
    jsonBody(request);
    const id = parsePurchaseOrderId(request.params.orderId);
    const key = parsePurchaseOrderIdempotencyKey(request.rawHeaders);
    const body = parsePurchaseOrderDelete(request.body);
    const result = await this.commands.deleteDraft(id, key, body);
    response.status(result.statusCode).end();
  }

  @Post(':orderId/confirm')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(
    ['read', 'ProcurementPurchaseOrder'],
    ['create', 'ProcurementOrderConfirmation'],
  )
  async confirm(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    noQuery(request);
    jsonBody(request);
    const id = parsePurchaseOrderId(request.params.orderId);
    const key = parsePurchaseOrderIdempotencyKey(request.rawHeaders);
    const body = parsePurchaseOrderConfirm(request.body);
    const result = await this.commands.confirm(id, key, body);
    response.status(result.statusCode);
    return result.body;
  }

  @Post(':orderId/cancel')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(
    ['read', 'ProcurementPurchaseOrder'],
    ['create', 'ProcurementOrderCancellation'],
  )
  async cancel(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    noQuery(request);
    jsonBody(request);
    const id = parsePurchaseOrderId(request.params.orderId);
    const key = parsePurchaseOrderIdempotencyKey(request.rawHeaders);
    const body = parsePurchaseOrderCancel(request.body);
    const result = await this.commands.cancel(id, key, body);
    response.status(result.statusCode);
    return result.body;
  }
}
