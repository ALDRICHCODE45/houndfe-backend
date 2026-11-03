import { Prisma, type Product, type Variant } from '@prisma/client';
import type {
  OrderInput,
  PurchaseOrder,
  SupplierDisplaySnapshot,
} from './po-contract';
import type { PurchaseOrderReferenceFacts } from './po-validation';

export interface PurchaseOrderReferences {
  facts: PurchaseOrderReferenceFacts;
  supplierDisplaySnapshot: SupplierDisplaySnapshot | null;
  lineDisplaySnapshots: PurchaseOrder['lineDisplaySnapshots'];
  tenantName: string;
}

/**
 * Caller owns lifecycle(shared) -> Tenant SHARE -> authority -> receipt -> order.
 * Then supplier UPDATE -> Product UPDATE (id) -> Variant SHARE (productId,id).
 * Never lock referencing orders from a supplier writer. Missing rows fail closed.
 */
export async function readPurchaseOrderReferences(
  tx: Prisma.TransactionClient,
  tenantId: string,
  tenantName: string,
  order: OrderInput,
): Promise<PurchaseOrderReferences> {
  const suppliers =
    order.supplierId === null
      ? []
      : await tx.$queryRaw<SupplierDisplaySnapshot[]>(Prisma.sql`
    SELECT s."id", s."displayName", s."status" FROM "procurement_suppliers" s
    WHERE s."tenantId" = ${tenantId} AND s."id" = ${order.supplierId}
    FOR UPDATE OF s
  `);
  const productIds = [
    ...new Set(
      order.lines.flatMap((line) =>
        line.productId === null ? [] : [line.productId],
      ),
    ),
  ].sort();
  const products =
    productIds.length === 0
      ? []
      : await tx.$queryRaw<
          Pick<Product, 'id' | 'name' | 'type' | 'unit' | 'hasVariants'>[]
        >(Prisma.sql`
    SELECT p."id", p."name", p."type", p."unit", p."hasVariants"
    FROM "products" p WHERE p."tenantId" = ${tenantId}
      AND p."id" IN (${Prisma.join(productIds)})
    ORDER BY p."id" ASC FOR UPDATE OF p
  `);
  const variantIds = [
    ...new Set(
      order.lines.flatMap((line) =>
        line.variantId === null ? [] : [line.variantId],
      ),
    ),
  ].sort();
  // Tenant-only lookup deliberately observes a same-tenant wrong parent as
  // incompatible, not missing. No foreign-tenant name or parent escapes.
  const variants =
    variantIds.length === 0
      ? []
      : await tx.$queryRaw<
          Pick<Variant, 'id' | 'name' | 'productId'>[]
        >(Prisma.sql`
    SELECT v."id", v."name", v."productId" FROM "variants" v
    WHERE v."tenantId" = ${tenantId} AND v."id" IN (${Prisma.join(variantIds)})
    ORDER BY v."productId" ASC, v."id" ASC FOR SHARE OF v
  `);
  const productById = new Map(products.map((product) => [product.id, product]));
  const variantById = new Map(variants.map((variant) => [variant.id, variant]));
  const facts: PurchaseOrderReferenceFacts = {
    supplier: suppliers[0]?.status ?? 'missing',
    lines: Object.fromEntries(
      order.lines.map((line) => {
        const product = productById.get(line.productId ?? '');
        const variant = variantById.get(line.variantId ?? '');
        return [
          line.lineId,
          {
            product: product
              ? {
                  type: product.type,
                  unit: product.unit,
                  hasVariants: product.hasVariants,
                }
              : 'missing',
            variant: variant
              ? { belongsToProduct: variant.productId === line.productId }
              : 'missing',
          },
        ];
      }),
    ),
  };
  return {
    facts,
    tenantName,
    supplierDisplaySnapshot: suppliers[0]
      ? {
          id: suppliers[0].id,
          displayName: suppliers[0].displayName,
          status: suppliers[0].status,
        }
      : null,
    lineDisplaySnapshots: order.lines.map((line) => {
      const product = productById.get(line.productId ?? '');
      const variant = variantById.get(line.variantId ?? '');
      return {
        lineId: line.lineId,
        productName: product?.type === 'PRODUCT' ? product.name : null,
        unit: product?.type === 'PRODUCT' ? product.unit : null,
        variantName:
          product?.type === 'PRODUCT' &&
          product.hasVariants &&
          variant?.productId === product.id
            ? variant.name
            : null,
      };
    }),
  };
}
