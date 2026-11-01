import type { Prisma } from '@prisma/client';
import type { DocumentAuthority } from '../domain/document';
import { selectEditorialOfferedSubjectsV2 } from '../domain/editorial-offered-subjects-v2';

/**
 * Caller owns authorization and a ReadCommitted transaction already holding
 * lifecycle SHARE -> actual Tenant SHARE -> qualified Product UPDATE through
 * validation, mutation, receipt and commit. TransactionClient alone proves none
 * of those preconditions. This reader neither acquires locks nor commits.
 */
export async function readEditorialOfferedSubjectsV2(
  tx: Prisma.TransactionClient,
  scope: Pick<DocumentAuthority, 'tenantId' | 'productId'>,
): Promise<(string | null)[]> {
  const { tenantId, productId } = scope;
  if (
    [tenantId, productId].some(
      (id) => typeof id !== 'string' || id.trim().length === 0,
    )
  ) {
    throw new TypeError('Invalid editorial offered-subject scope');
  }
  const product = await tx.product.findFirst({
    where: { id: productId, tenantId },
    select: {
      type: true,
      includeInOnlineCatalog: true,
      hidePriceInOnlineCatalog: true,
      requiresPrescription: true,
      hasVariants: true,
      tenant: {
        select: {
          tenantCatalogPriceLists: {
            where: { tenantId },
            select: { globalPriceListId: true },
          },
        },
      },
      catalogPriceLists: {
        where: { tenantId, productId },
        select: { globalPriceListId: true },
      },
      priceLists: {
        where: { tenantId, productId },
        select: { id: true, globalPriceListId: true, priceCents: true },
      },
      variants: {
        where: { tenantId, productId },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          catalogPublishMode: true,
          variantPrices: {
            where: { tenantId, priceList: { tenantId, productId } },
            select: { priceListId: true, priceCents: true },
          },
        },
      },
    },
  });
  if (!product) throw new Error('NOT_FOUND');
  return selectEditorialOfferedSubjectsV2({
    availableGlobalPriceListIds: product.tenant.tenantCatalogPriceLists.map(
      (binding) => binding.globalPriceListId,
    ),
    product,
    supportedCatalogPriceListIds: product.catalogPriceLists.map(
      (binding) => binding.globalPriceListId,
    ),
    productPrices: product.priceLists,
    variants: product.variants.map((variant) => ({
      id: variant.id,
      catalogPublishMode: variant.catalogPublishMode,
      prices: variant.variantPrices,
    })),
  });
}
