import { Controller, Get, UseGuards, UseInterceptors } from '@nestjs/common';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import { PublicTenantGuard } from './guards/public-tenant.guard';
import {
  PublicTenant,
  type PublicTenantInfo,
} from './decorators/public-tenant.decorator';
import {
  CacheControl,
  CacheControlInterceptor,
} from './interceptors/cache-control.interceptor';
import { GetPublicBranchUseCase } from '../application/use-cases/get-public-branch.use-case';

/**
 * Public catalog v0 (S4) — `GET /public/catalog/:tenantSlug/branch`. Same
 * gate, throttling and cache wiring as `PublicCatalogController`; kept in its
 * own controller so that class keeps its constructor.
 */
@Controller('public/catalog')
@SkipThrottle({ 'public-validate': true })
@UseGuards(PublicTenantGuard, ThrottlerGuard)
@UseInterceptors(CacheControlInterceptor)
export class PublicBranchController {
  constructor(private readonly getBranch: GetPublicBranchUseCase) {}

  @Get(':tenantSlug/branch')
  @CacheControl('public, max-age=300')
  async getBranchDetail(@PublicTenant() tenant: PublicTenantInfo) {
    return this.getBranch.execute(tenant);
  }
}
