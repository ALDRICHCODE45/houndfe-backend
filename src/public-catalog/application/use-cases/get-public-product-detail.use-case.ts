import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  type IPublicCatalogRepository,
  PUBLIC_CATALOG_REPOSITORY,
} from '../ports/public-catalog.repository';
import { toPublicProductDetail } from '../mappers/public-product.mapper';
import type { PublicCatalogProductDetail } from '../dto/public-product-detail.dto';

@Injectable()
export class GetPublicProductDetailUseCase {
  constructor(
    @Inject(PUBLIC_CATALOG_REPOSITORY)
    private readonly repo: IPublicCatalogRepository,
  ) {}

  async execute(
    productId: string,
    tenant: { id: string; slug: string; name: string },
  ): Promise<PublicCatalogProductDetail> {
    // F1.WU5b — fail closed: without a resolved tenant catalog-default
    // global price list, no product read happens and the existing
    // NotFoundException('Not Found') path is taken.
    const defaultPriceListId =
      (await this.repo.findTenantCatalogDefaultPriceListId?.()) ?? null;
    if (defaultPriceListId === null) {
      throw new NotFoundException('Not Found');
    }

    const product = await this.repo.findProductById(
      productId,
      defaultPriceListId,
    );

    if (!product) {
      throw new NotFoundException('Not Found');
    }

    return toPublicProductDetail(product, tenant);
  }
}
