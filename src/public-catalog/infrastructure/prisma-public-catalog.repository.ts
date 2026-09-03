import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { PublicBranchDto } from '../application/dto/public-branch.dto';
import type { PublicCatalogCategoryFacet } from '../application/dto/public-category-facet.dto';
import type {
  IPublicCatalogRepository,
  ListProductsParams,
} from '../application/ports/public-catalog.repository';
import type {
  ProductWithIncludes,
  ProductDetailWithIncludes,
} from '../application/mappers/public-product.mapper';
import type { Prisma } from '@prisma/client';

/**
 * F1.WU5c1 — single publication-survivorship predicate. A product survives
 * when it has no variants, or when at least one variant is not OFF
 * (INHERIT or ON). Always combined with the parent gates, so an ON variant
 * can never widen a false `includeInOnlineCatalog` gate.
 */
const PUBLICATION_SURVIVORSHIP: Prisma.ProductWhereInput = {
  OR: [
    { hasVariants: false },
    { variants: { some: { catalogPublishMode: { not: 'OFF' } } } },
  ],
};

@Injectable()
export class PrismaPublicCatalogRepository implements IPublicCatalogRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantPrisma: TenantPrismaService,
  ) {}

  async findActiveBranches(): Promise<PublicBranchDto[]> {
    // Uses raw PrismaService (NOT tenant-scoped) — global query
    const tenants = await this.prisma.tenant.findMany({
      where: { isActive: true, catalogPublished: true },
      select: { id: true, name: true, slug: true, address: true, phone: true },
      orderBy: { name: 'asc' },
    });

    return tenants.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      address: t.address,
      phone: t.phone,
    }));
  }

  /**
   * F1.WU5b — resolves the current tenant's catalog-default binding to its
   * global price-list ID. Returns null (never a fallback list) when the
   * tenant has no `isCatalogDefault=true` binding.
   */
  async findTenantCatalogDefaultPriceListId(): Promise<string | null> {
    const client = this.tenantPrisma.getClient();

    const binding = await client.tenantCatalogPriceList.findFirst({
      where: {
        tenantId: this.tenantPrisma.getTenantId(),
        isCatalogDefault: true,
      },
      select: { globalPriceListId: true },
    });

    return binding?.globalPriceListId ?? null;
  }

  async findProducts(
    params: ListProductsParams,
  ): Promise<{ items: ProductWithIncludes[]; total: number }> {
    const client = this.tenantPrisma.getClient();

    const where: Prisma.ProductWhereInput = {
      includeInOnlineCatalog: true,
      type: 'PRODUCT',
      AND: [PUBLICATION_SURVIVORSHIP],
    };

    if (params.categoryId) where.categoryId = params.categoryId;
    if (params.q) {
      where.OR = [
        { name: { contains: params.q, mode: 'insensitive' as const } },
        {
          brand: {
            name: {
              contains: params.q,
              mode: 'insensitive' as const,
            },
          },
        },
        {
          variants: {
            some: {
              catalogPublishMode: { not: 'OFF' },
              OR: [
                {
                  name: {
                    contains: params.q,
                    mode: 'insensitive' as const,
                  },
                },
                {
                  option: {
                    contains: params.q,
                    mode: 'insensitive' as const,
                  },
                },
                {
                  value: {
                    contains: params.q,
                    mode: 'insensitive' as const,
                  },
                },
              ],
            },
          },
        },
      ];
    }

    const orderBy = this.resolveOrderBy(params.sort);

    // F1.WU5b — tenant catalog-default compatibility: when a resolved ID is
    // threaded, ONLY that global price list is queried (no fallback to the
    // global default). The legacy isDefault filter remains exclusively for
    // callers that predate tenant price contexts (e.g. chatbot-api).
    const { priceListWhere, variantPriceWhere } = this.resolvePriceFilters(
      params.globalPriceListId,
    );

    const productQuery = client.product.findMany({
      where,
      orderBy,
      skip: (params.page - 1) * params.limit,
      take: params.limit,
      include: {
        category: { select: { id: true, name: true } },
        brand: { select: { name: true } },
        images: {
          where: { isMain: true, variantId: null },
          take: 1,
          select: { url: true },
        },
        priceLists: {
          where: priceListWhere,
          select: { priceCents: true },
          take: 1,
        },
        variants: {
          where: { catalogPublishMode: { not: 'OFF' } },
          select: {
            id: true,
            name: true,
            option: true,
            value: true,
            quantity: true,
            minQuantity: true,
            // F1.WU5c2 — carried so the mapper can defensively filter OFF
            // variants for alternate/legacy callers.
            catalogPublishMode: true,
            variantPrices: {
              where: variantPriceWhere,
              select: { priceCents: true },
              take: 1,
            },
          },
        },
      },
    });

    const [items, total] = await Promise.all([
      productQuery,
      client.product.count({ where }),
    ]);

    return {
      items: this.sortByPriceIfNeeded(
        // SAFETY: The include shape above matches ProductWithIncludes; this bridges Prisma's conditional query inference.
        items as unknown as ProductWithIncludes[],
        params.sort,
      ),
      total,
    };
  }

  async findCategoryFacets(params: {
    q?: string;
  }): Promise<PublicCatalogCategoryFacet[]> {
    const client = this.tenantPrisma.getClient();

    const where: Prisma.ProductWhereInput = {
      includeInOnlineCatalog: true,
      type: 'PRODUCT',
      AND: [PUBLICATION_SURVIVORSHIP],
    };

    if (params.q) {
      where.OR = [
        { name: { contains: params.q, mode: 'insensitive' as const } },
        {
          brand: {
            name: {
              contains: params.q,
              mode: 'insensitive' as const,
            },
          },
        },
      ];
    }

    const facets = await client.product.groupBy({
      by: ['categoryId'],
      where,
      _count: { id: true },
    });

    const categoryIds = facets
      .map((f) => f.categoryId)
      .filter((id): id is string => id != null);

    if (categoryIds.length === 0) return [];

    const categories = await this.prisma.category.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true, name: true },
    });

    const categoryMap = new Map(categories.map((c) => [c.id, c.name]));

    return facets
      .flatMap((facet) => {
        const categoryId = facet.categoryId;
        if (categoryId == null) return [];

        const name = categoryMap.get(categoryId);
        if (name == null) return [];

        return [{ id: categoryId, name, count: facet._count.id }];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async findProductById(
    productId: string,
    globalPriceListId?: string,
  ): Promise<ProductDetailWithIncludes | null> {
    const client = this.tenantPrisma.getClient();

    const { priceListWhere, variantPriceWhere } =
      this.resolvePriceFilters(globalPriceListId);

    const product = await client.product.findFirst({
      where: {
        id: productId,
        includeInOnlineCatalog: true,
        type: 'PRODUCT',
        AND: [PUBLICATION_SURVIVORSHIP],
      },
      include: {
        category: { select: { id: true, name: true } },
        brand: { select: { name: true } },
        images: {
          where: { variantId: null },
          orderBy: [{ isMain: 'desc' }, { sortOrder: 'asc' }],
          select: { id: true, url: true, isMain: true },
        },
        priceLists: {
          where: priceListWhere,
          select: { priceCents: true },
          take: 1,
        },
        variants: {
          where: { catalogPublishMode: { not: 'OFF' } },
          // include carries every variant scalar — catalogPublishMode
          // included — so the mapper's defensive OFF filter (F1.WU5c2)
          // always sees the mode.
          include: {
            images: {
              orderBy: [{ isMain: 'desc' }, { sortOrder: 'asc' }],
              take: 1,
              select: { url: true },
            },
            variantPrices: {
              where: variantPriceWhere,
              select: { priceCents: true },
              take: 1,
            },
          },
        },
      },
    });

    if (!product) return null;

    // SAFETY: The include shape above matches ProductDetailWithIncludes; this bridges Prisma's conditional query inference.
    return product as unknown as ProductDetailWithIncludes;
  }

  /**
   * F1.WU5b — price filters for one execution. With a threaded resolved
   * tenant catalog-default ID only that list is selected; without one the
   * legacy global-default filter is preserved for pre-context callers.
   */
  private resolvePriceFilters(globalPriceListId?: string): {
    priceListWhere: Prisma.PriceListWhereInput;
    variantPriceWhere: Prisma.VariantPriceWhereInput;
  } {
    if (globalPriceListId) {
      return {
        priceListWhere: { globalPriceListId },
        variantPriceWhere: { priceList: { globalPriceListId } },
      };
    }

    return {
      priceListWhere: { globalPriceList: { isDefault: true } },
      variantPriceWhere: {
        priceList: { globalPriceList: { isDefault: true } },
      },
    };
  }

  private resolveOrderBy(
    sort: string,
  ): Prisma.ProductOrderByWithRelationInput[] {
    switch (sort) {
      case 'price_asc':
      case 'price_desc':
        // Price sort is done in application layer via sortByPriceIfNeeded()
        // because Prisma does not support orderBy on relation aggregate fields.
        // Use createdAt as stable DB-level ordering for deterministic pagination.
        return [{ createdAt: 'desc' }];
      case 'rating_desc':
      case 'relevance':
      case 'newest':
      default:
        return [{ createdAt: 'desc' }];
    }
  }

  /**
   * Post-sorts fetched products by their default price list priceCents.
   * Only applied for price_asc / price_desc sorts. Products without a price
   * list entry are placed last (asc) or first (desc).
   *
   * NOTE: This sorts within the current page only. For large catalogs with
   * thousands of products, accurate cross-page price sorting would require
   * raw SQL ORDER BY. Acceptable for v1 MVP with <10K products/tenant.
   */
  private sortByPriceIfNeeded(
    items: ProductWithIncludes[],
    sort: string,
  ): ProductWithIncludes[] {
    if (sort !== 'price_asc' && sort !== 'price_desc') return items;

    const getPrice = (p: ProductWithIncludes): number | null =>
      p.priceLists[0]?.priceCents ?? null;

    return [...items].sort((a, b) => {
      const priceA = getPrice(a);
      const priceB = getPrice(b);

      // Nulls last for asc, first for desc
      if (priceA == null && priceB == null) return 0;
      if (priceA == null) return sort === 'price_asc' ? 1 : -1;
      if (priceB == null) return sort === 'price_asc' ? -1 : 1;

      const diff = sort === 'price_asc' ? priceA - priceB : priceB - priceA;
      // Tiebreaker: name ascending
      if (diff === 0) return a.name.localeCompare(b.name);
      return diff;
    });
  }
}
