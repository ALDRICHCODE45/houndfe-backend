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

@Injectable()
export class PrismaPublicCatalogRepository implements IPublicCatalogRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantPrisma: TenantPrismaService,
  ) {}

  async findActiveBranches(): Promise<PublicBranchDto[]> {
    // Uses raw PrismaService (NOT tenant-scoped) — global query
    const tenants = await this.prisma.tenant.findMany({
      where: { isActive: true },
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

  async findProducts(
    params: ListProductsParams,
  ): Promise<{ items: ProductWithIncludes[]; total: number }> {
    const client = this.tenantPrisma.getClient();

    const where: Prisma.ProductWhereInput = {
      includeInOnlineCatalog: true,
      type: 'PRODUCT',
      ...(params.categoryId ? { categoryId: params.categoryId } : {}),
      ...(params.q
        ? {
            OR: [
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
            ],
          }
        : {}),
    };

    const orderBy = this.resolveOrderBy(params.sort);

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
          where: { globalPriceList: { isDefault: true } },
          select: { priceCents: true },
          take: 1,
        },
        variants: {
          select: {
            id: true,
            name: true,
            option: true,
            value: true,
            quantity: true,
            minQuantity: true,
            variantPrices: {
              where: {
                priceList: { globalPriceList: { isDefault: true } },
              },
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
      ...(params.q
        ? {
            OR: [
              { name: { contains: params.q, mode: 'insensitive' as const } },
              {
                brand: {
                  name: {
                    contains: params.q,
                    mode: 'insensitive' as const,
                  },
                },
              },
            ],
          }
        : {}),
    };

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
      .filter((f) => f.categoryId != null && categoryMap.has(f.categoryId))
      .map((f) => ({
        id: f.categoryId!,
        name: categoryMap.get(f.categoryId!)!,
        count: f._count.id,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async findProductById(
    productId: string,
  ): Promise<ProductDetailWithIncludes | null> {
    const client = this.tenantPrisma.getClient();

    const product = await client.product.findFirst({
      where: { id: productId, includeInOnlineCatalog: true },
      include: {
        category: { select: { id: true, name: true } },
        brand: { select: { name: true } },
        images: {
          where: { variantId: null },
          orderBy: [{ isMain: 'desc' }, { sortOrder: 'asc' }],
          select: { id: true, url: true, isMain: true },
        },
        priceLists: {
          where: { globalPriceList: { isDefault: true } },
          select: { priceCents: true },
          take: 1,
        },
        variants: {
          include: {
            images: {
              orderBy: [{ isMain: 'desc' }, { sortOrder: 'asc' }],
              take: 1,
              select: { url: true },
            },
            variantPrices: {
              where: {
                priceList: { globalPriceList: { isDefault: true } },
              },
              select: { priceCents: true },
              take: 1,
            },
          },
        },
      },
    });

    if (!product) return null;

    return product as unknown as ProductDetailWithIncludes;
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
