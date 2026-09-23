import { Inject, Injectable } from '@nestjs/common';
import type { PublicTenantInfo } from '../../http/decorators/public-tenant.decorator';
import type { PublicPriceContextDto } from '../dto/public-price-context.dto';
import {
  PUBLIC_CATALOG_REPOSITORY,
  type IPublicCatalogRepository,
} from '../ports/public-catalog.repository';

@Injectable()
export class ListPublicPriceContextsUseCase {
  constructor(
    @Inject(PUBLIC_CATALOG_REPOSITORY)
    private readonly repo: IPublicCatalogRepository,
  ) {}

  execute(tenant: PublicTenantInfo): Promise<PublicPriceContextDto[]> {
    return this.repo.listTenantPublicPriceContexts(tenant.id);
  }
}
