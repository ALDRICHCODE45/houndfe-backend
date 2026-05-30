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
            ],
          }
        : {}),
    };

    const orderBy = this.resolveOrderBy(params.sort);

    const [items, total] = await Promise.all([
      client.product.findMany({
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
      }) as unknown as ProductWithIncludes[],
      client.product.count({ where }),
    ]);

    return { items, total };
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
        return [{ priceLists: { _count: 'asc' } }, { name: 'asc' }];
      case 'price_desc':
        return [{ priceLists: { _count: 'desc' } }, { name: 'asc' }];
      case 'relevance':
      case 'newest':
      default:
        return [{ createdAt: 'desc' }];
    }
  }
}
