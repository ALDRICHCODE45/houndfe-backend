import { Inject, Injectable } from '@nestjs/common';
import {
  PUBLIC_CATALOG_REPOSITORY,
  type IPublicCatalogRepository,
  type ResolvedPublicCatalogContext,
} from '../ports/public-catalog.repository';
import { PriceContextNotAvailableError } from '../../domain/errors/price-context-not-available.error';

/**
 * F2.WU6 — resolves the one public price context per request. `priceListId`
 * means `GlobalPriceList.id` (exact tenant-bound public ID, or the tenant's
 * catalog default when omitted). Every miss throws the single generic error.
 */
@Injectable()
export class PublicPriceContextResolver {
  constructor(
    @Inject(PUBLIC_CATALOG_REPOSITORY)
    private readonly repository: IPublicCatalogRepository,
  ) {}

  async resolve(
    tenantSlug: string,
    requestedGlobalPriceListId?: string,
  ): Promise<ResolvedPublicCatalogContext> {
    const context = await this.repository.resolveTenantCatalogContext(
      tenantSlug,
      requestedGlobalPriceListId,
    );

    if (!context) throw new PriceContextNotAvailableError();

    return context;
  }
}
