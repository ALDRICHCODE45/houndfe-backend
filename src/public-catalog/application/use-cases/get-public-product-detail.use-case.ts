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
    const product = await this.repo.findProductById(productId);

    if (!product) {
      throw new NotFoundException('Not Found');
    }

    return toPublicProductDetail(product, tenant);
  }
}
