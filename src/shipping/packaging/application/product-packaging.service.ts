/**
 * shipping-zones / T2 (S4) — packaging per product with a whole-record
 * override per variant.
 *
 * Tenant isolation: `Product`, `Variant` and both packaging models are in
 * `TENANT_SCOPED_MODELS`, and every query also carries the owning `tenantId`
 * explicitly. A product or variant outside the caller's tenant is a 404.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { EntityNotFoundError } from '../../../shared/domain/domain-error';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantPrismaService } from '../../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../../shared/tenant/tenant-cls-store.interface';
import type { PackageItem } from '../domain/order-package';
import type {
  PackagingView,
  ProductPackagingResponse,
  PutPackagingDto,
  VariantPackagingResponse,
} from '../dto/packaging.dto';

interface PackagingRow {
  weightG: number;
  lengthCm: Prisma.Decimal;
  widthCm: Prisma.Decimal;
  heightCm: Prisma.Decimal;
  updatedAt: Date;
}

export interface PackageLine {
  productId: string;
  variantId: string | null;
  quantity: number;
}

const toView = (row: PackagingRow | null): PackagingView | null =>
  row && {
    weightG: row.weightG,
    lengthCm: Number(row.lengthCm),
    widthCm: Number(row.widthCm),
    heightCm: Number(row.heightCm),
    updatedAt: row.updatedAt.toISOString(),
  };

@Injectable()
export class ProductPackagingService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  async getProduct(productId: string): Promise<ProductPackagingResponse> {
    const product = await this.requireProduct(productId);
    const row = await this.db.productPackaging.findFirst({
      where: { productId, tenantId: product.tenantId },
    });
    return { productId, packaging: toView(row) };
  }

  async putProduct(
    productId: string,
    dto: PutPackagingDto,
  ): Promise<ProductPackagingResponse> {
    const { tenantId } = await this.requireProduct(productId);
    const row = await this.db.productPackaging.upsert({
      where: { productId, tenantId },
      create: { productId, tenantId, ...dto },
      update: { ...dto },
    });
    return { productId, packaging: toView(row) };
  }

  async deleteProduct(productId: string): Promise<void> {
    const { tenantId } = await this.requireProduct(productId);
    await this.db.productPackaging.deleteMany({
      where: { productId, tenantId },
    });
  }

  async getVariant(
    productId: string,
    variantId: string,
  ): Promise<VariantPackagingResponse> {
    const { tenantId } = await this.requireVariant(productId, variantId);
    return this.variantView(tenantId, productId, variantId);
  }

  async putVariant(
    productId: string,
    variantId: string,
    dto: PutPackagingDto,
  ): Promise<VariantPackagingResponse> {
    const { tenantId } = await this.requireVariant(productId, variantId);
    await this.db.variantPackaging.upsert({
      where: { variantId, tenantId },
      create: { variantId, tenantId, ...dto },
      update: { ...dto },
    });
    return this.variantView(tenantId, productId, variantId);
  }

  async deleteVariant(productId: string, variantId: string): Promise<void> {
    const { tenantId } = await this.requireVariant(productId, variantId);
    await this.db.variantPackaging.deleteMany({
      where: { variantId, tenantId },
    });
  }

  /**
   * Quote-engine entry point (T3): effective packaging of each line for the
   * pure `buildOrderPackage`. Lines without data (or unknown in this tenant)
   * come back with null weight/dims so the packing rule reports them as
   * PACKAGING_DATA_MISSING. Takes the tenant explicitly and uses the base
   * client with `tenantId` filters, so it also works outside a request CLS
   * scope (jobs, bot flows).
   */
  async resolvePackageItems(
    tenantId: string,
    lines: PackageLine[],
  ): Promise<PackageItem[]> {
    const productIds = [...new Set(lines.map((l) => l.productId))];
    const variantIds = [
      ...new Set(lines.flatMap((l) => (l.variantId ? [l.variantId] : []))),
    ];
    const [products, variants] = await Promise.all([
      this.prisma.productPackaging.findMany({
        where: { tenantId, productId: { in: productIds } },
      }),
      this.prisma.variantPackaging.findMany({
        where: {
          tenantId,
          variantId: { in: variantIds },
          variant: { productId: { in: productIds } },
        },
        include: { variant: { select: { productId: true } } },
      }),
    ]);
    const byProduct = new Map(products.map((p) => [p.productId, p]));
    const byVariant = new Map(variants.map((v) => [v.variantId, v]));
    return lines.map((line) => {
      const override = line.variantId ? byVariant.get(line.variantId) : null;
      const own =
        override && override.variant.productId === line.productId
          ? override
          : null;
      const view = toView(own ?? byProduct.get(line.productId) ?? null);
      return {
        productId: line.productId,
        variantId: line.variantId,
        quantity: line.quantity,
        packageWeightG: view?.weightG ?? null,
        dims: view && {
          lengthCm: view.lengthCm,
          widthCm: view.widthCm,
          heightCm: view.heightCm,
        },
      };
    });
  }

  private get db() {
    return this.tenantPrisma.getClient();
  }

  /** The CLS tenant, or no filter for a tenant-less super admin. */
  private tenantFilter(): { tenantId?: string } {
    const tenantId = this.cls.get('tenantId');
    return tenantId ? { tenantId } : {};
  }

  private async requireProduct(productId: string) {
    const product = await this.db.product.findFirst({
      where: { id: productId, ...this.tenantFilter() },
      select: { id: true, tenantId: true },
    });
    if (!product) throw new EntityNotFoundError('Product', productId);
    return product;
  }

  private async requireVariant(productId: string, variantId: string) {
    const variant = await this.db.variant.findFirst({
      where: { id: variantId, productId, ...this.tenantFilter() },
      select: { id: true, tenantId: true },
    });
    if (!variant) throw new EntityNotFoundError('Variant', variantId);
    return variant;
  }

  private async variantView(
    tenantId: string,
    productId: string,
    variantId: string,
  ): Promise<VariantPackagingResponse> {
    const [override, product] = await Promise.all([
      this.db.variantPackaging.findFirst({ where: { variantId, tenantId } }),
      this.db.productPackaging.findFirst({ where: { productId, tenantId } }),
    ]);
    const overrideView = toView(override);
    const productView = toView(product);
    return {
      productId,
      variantId,
      override: overrideView,
      productPackaging: productView,
      effective: overrideView ?? productView,
      source: overrideView ? 'VARIANT' : productView ? 'PRODUCT' : null,
    };
  }
}
