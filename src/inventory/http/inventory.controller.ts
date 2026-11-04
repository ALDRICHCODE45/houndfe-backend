import {
  Controller,
  Get,
  Header,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { InventoryCommands } from './inventory-commands';
import {
  InventoryContractError,
  parseInventoryId,
  parseInventoryIdempotencyKey,
} from './inventory-contract';
import { InventoryHttpFilter } from './inventory-http.filter';
import { InventoryQueries } from './inventory-queries';

function noQuery(request: Request): void {
  if (Object.keys(request.query).length)
    throw new InventoryContractError('MALFORMED');
}
function noBody(request: Request): void {
  if (
    request.headers['transfer-encoding'] !== undefined ||
    Number(request.headers['content-length'] ?? 0) > 0
  )
    throw new InventoryContractError('MALFORMED');
}
function jsonBody(request: Request): void {
  if (!request.is('application/json'))
    throw new InventoryContractError('MALFORMED');
}

@Controller('inventory')
@UseFilters(InventoryHttpFilter)
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class InventoryController {
  constructor(
    private readonly commands: InventoryCommands,
    private readonly queries: InventoryQueries,
  ) {}

  @Get('products/:productId/stock')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(['read', 'InventoryJournal'])
  stock(@Req() request: Request) {
    noQuery(request);
    noBody(request);
    return this.queries.getStock(parseInventoryId(request.params.productId));
  }

  @Get('movements')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(['read', 'InventoryJournal'])
  movements(@Req() request: Request) {
    noBody(request);
    return this.queries.listMovements(request.query);
  }

  @Post('adjustments')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(
    ['read', 'InventoryJournal'],
    ['create', 'InventoryAdjustment'],
  )
  async adjust(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    noQuery(request);
    jsonBody(request);
    const key = parseInventoryIdempotencyKey(request.rawHeaders);
    const result = await this.commands.adjust(key, request.body);
    response.status(result.statusCode);
    return result.body;
  }
}
