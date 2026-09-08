import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  type IPublicCatalogRepository,
  PUBLIC_CATALOG_REPOSITORY,
} from '../ports/public-catalog.repository';
import { toPublicProductDetail, toPublicProductDetailForContext } from '../mappers/public-product.mapper';
import type { PublicCatalogProductDetail } from '../dto/public-product-detail.dto';
import type {
  PublicCatalogProductDetailWithContextDto,
  PublicPriceContextDto,
} from '../dto/public-price-context.dto';
import type { ResolvedPublicCatalogContext } from '../ports/public-catalog.repository';

/** F2.WU6 slice 4b — input for the dormant context-explicit detail seam. */
export interface GetPublicProductDetailForContextInput {
  productId: string;
  tenant: { id: string; slug: string; name: string };
  /** Already resolved by the upstream price-context resolver. */
  context: ResolvedPublicCatalogContext;
}

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

  /**
   * F2.WU6 slice 4b — context-explicit detail seam. The price context
   * arrives already resolved by the upstream resolver; this method only
   * maps the exact repository projection into the public detail shape
   * and appends exact public metadata. It fails closed with the generic
   * `NotFoundException('Not Found')` on tenant ID or slug mismatch
   * (before any repository access), on an absent optional
   * `getPublicProductDetail` seam (no optional-chain into undefined, no
   * fallback), on a null projection, and — F3.WU9 slice 7 — on invalid
   * stock-presentation participants (one safe internal warning first).
   * It never touches the active default-list path
   * (`findTenantCatalogDefaultPriceListId`, `findProductById`) and never
   * resolves a context itself.
   */
  async executeForContext(
    input: GetPublicProductDetailForContextInput,
  ): Promise<PublicCatalogProductDetailWithContextDto> {
    const { productId, tenant, context } = input;

    // Fail closed before any repository access when the request tenant
    // does not match the resolved public price context.
    if (tenant.id !== context.tenantId || tenant.slug !== context.tenantSlug) {
      throw new NotFoundException('Not Found');
    }

    // Optional seam: absent implementation is a generic miss — never an
    // optional-chain into undefined and never a legacy fallback.
    if (!this.repo.getPublicProductDetail) {
      throw new NotFoundException('Not Found');
    }

    const product = await this.repo.getPublicProductDetail({
      tenantId: tenant.id,
      productId,
      context,
    });

    if (!product) {
      throw new NotFoundException('Not Found');
    }

    // Exact projection mapping only — alternate/default/global prices are
    // never inspected or recovered here; the mapper redacts hidden and
    // prescription prices defensively. F3.WU9 slice 7 — stock
    // presentation maps from the context defaults only.
    const detail = toPublicProductDetailForContext(
      product,
      tenant,
      context.stockPresentationDefaults,
    );

    const priceContext: PublicPriceContextDto = {
      priceListId: context.globalPriceListId,
      name: context.name,
      isCatalogDefault: context.isCatalogDefault,
    };

    return { ...detail, priceContext, excludedCount: 0 };
  }
}
