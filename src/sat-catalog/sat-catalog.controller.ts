/**
 * SatCatalogController — HTTP Adapter (Driver Port).
 *
 * Exposes the SAT c_ClaveProdServ catalog for editor typeahead and
 * legacy-key resolution. The catalog is non-tenant reference data, but
 * the auth stack still requires a JWT + tenant context + `read:SatKey`
 * permission (the controller is mounted behind the same guards as any
 * other tenant-scoped resource).
 *
 * Guard stack mirrors `src/products/products.controller.ts:43` exactly —
 * three guards in order: JwtAuthGuard → TenantContextGuard →
 * PermissionsGuard. Permissions read from `@RequirePermissions(...)`
 * metadata via the global `Reflector` in `PermissionsGuard`.
 *
 * Routes:
 *   GET /sat-keys              → typeahead search (DTO: SearchSatKeyDto)
 *   GET /sat-keys/:key         → single-key lookup (404 on miss; returns
 *                                ACTIVE AND retired rows so editor UIs
 *                                can resolve legacy keys)
 *
 * The `notFound` contract — only one route (`:key`) can 404. The search
 * route returns `{items: [], total: 0}` on an empty result and never
 * throws 404 (per spec R1/R2/R3).
 */
import {
  Controller,
  Get,
  Param,
  Query,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { SatCatalogService } from './sat-catalog.service';
import { SearchSatKeyDto } from './dto/search-sat-key.dto';

@Controller('sat-keys')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
@RequirePermissions(['read', 'SatKey'])
export class SatCatalogController {
  constructor(private readonly service: SatCatalogService) {}

  /** GET /sat-keys — typeahead search. */
  @Get()
  search(@Query() query: SearchSatKeyDto) {
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;
    return this.service.search(query.search ?? '', { limit, offset });
  }

  /** GET /sat-keys/:key — single-key lookup. 404 on miss. Retired OK. */
  @Get(':key')
  async findOne(@Param('key') key: string) {
    const row = await this.service.findByKey(key);
    if (!row) {
      throw new NotFoundException(
        `SAT key "${key}" is not in the catalog.`,
      );
    }
    return row;
  }
}
