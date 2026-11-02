import {
  Controller,
  Get,
  Post,
  Patch,
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
import { SupplierCommands } from './supplier-commands';
import { SupplierQueries } from './supplier-queries';
import { SupplierHttpFilter } from './supplier-http.filter';
import {
  parseSupplierId,
  parseSupplierIdempotencyKey,
  parseSupplierInput,
  parseSupplierUpdate,
  parseSupplierListQuery,
  SupplierContractError,
} from './supplier-contract';

function noQuery(request: Request): void {
  if (Object.keys(request.query).length)
    throw new SupplierContractError('MALFORMED');
}
function noBody(request: Request): void {
  // Node validates HTTP framing before routing. Inspect that framing rather
  // than parser output: unsupported media bodies stay undefined, while an
  // empty JSON/form stream can become {}. Chunked framing declares a body
  // stream and is disallowed without consuming it or changing global parsers.
  if (
    request.headers['transfer-encoding'] !== undefined ||
    Number(request.headers['content-length'] ?? 0) > 0
  )
    throw new SupplierContractError('MALFORMED');
}

@Controller('procurement/suppliers')
@UseFilters(SupplierHttpFilter)
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class SuppliersController {
  constructor(
    private readonly commands: SupplierCommands,
    private readonly queries: SupplierQueries,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(['read', 'ProcurementSupplier'])
  list(@Req() request: Request) {
    noBody(request);
    parseSupplierListQuery(request.query);
    // Preserve primitive query admission; never DTO-coerce arrays/duplicates.
    return this.queries.list(request.query);
  }

  @Get(':supplierId')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(['read', 'ProcurementSupplier'])
  detail(@Req() request: Request) {
    noQuery(request);
    noBody(request);
    return this.queries.detail(parseSupplierId(request.params.supplierId));
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(['create', 'ProcurementSupplier'])
  async create(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    noQuery(request);
    const key = parseSupplierIdempotencyKey(request.rawHeaders);
    const body = parseSupplierInput(request.body);
    const result = await this.commands.create(key, body);
    response.status(result.statusCode);
    return result.body;
  }

  @Patch(':supplierId')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions(
    ['read', 'ProcurementSupplier'],
    ['update', 'ProcurementSupplier'],
  )
  async update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    noQuery(request);
    const id = parseSupplierId(request.params.supplierId);
    const key = parseSupplierIdempotencyKey(request.rawHeaders);
    const body = parseSupplierUpdate(request.body);
    const result = await this.commands.update(id, key, body);
    response.status(result.statusCode);
    return result.body;
  }
}
