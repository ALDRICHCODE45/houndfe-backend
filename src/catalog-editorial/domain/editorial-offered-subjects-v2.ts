export interface EditorialOfferedSubjectObservationV2 {
  readonly availableGlobalPriceListIds: readonly string[];
  readonly product: {
    readonly type: 'PRODUCT' | 'SERVICE';
    readonly includeInOnlineCatalog: boolean;
    readonly hidePriceInOnlineCatalog: boolean;
    readonly requiresPrescription: boolean;
    readonly hasVariants: boolean;
  };
  readonly supportedCatalogPriceListIds: readonly string[];
  readonly productPrices: readonly {
    readonly id: string;
    readonly globalPriceListId: string;
    readonly priceCents: number;
  }[];
  readonly variants: readonly {
    readonly id: string;
    readonly catalogPublishMode: 'ON' | 'OFF' | 'INHERIT';
    readonly prices: readonly {
      readonly priceListId: string;
      readonly priceCents: number;
    }[];
  }[];
}

/** Caller supplies a complete, coherent, ownership-qualified persisted observation. */
export function selectEditorialOfferedSubjectsV2(
  observation: EditorialOfferedSubjectObservationV2,
): (string | null)[] {
  const { product, variants } = observation;
  const available = new Set(observation.availableGlobalPriceListIds);
  if (
    available.size === 0 ||
    product.type !== 'PRODUCT' ||
    !product.includeInOnlineCatalog
  ) {
    return [];
  }

  const bypassPrices =
    product.hidePriceInOnlineCatalog || product.requiresPrescription;
  const supported = new Set(observation.supportedCatalogPriceListIds);
  const positivePriceRows = new Set(
    observation.productPrices
      .filter(
        (row) =>
          row.priceCents > 0 &&
          available.has(row.globalPriceListId) &&
          (supported.size === 0 || supported.has(row.globalPriceListId)),
      )
      .map((row) => row.id),
  );
  if (!product.hasVariants) {
    return bypassPrices || positivePriceRows.size > 0 ? [null] : [];
  }

  return [
    ...new Set(
      variants
        .filter(
          (variant) =>
            variant.catalogPublishMode !== 'OFF' &&
            (bypassPrices ||
              variant.prices.some(
                (price) =>
                  price.priceCents > 0 &&
                  positivePriceRows.has(price.priceListId),
              )),
        )
        .map((variant) => variant.id),
    ),
  ];
}
