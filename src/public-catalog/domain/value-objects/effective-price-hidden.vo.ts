export function isEffectivelyPriceHidden(product: {
  hidePriceInOnlineCatalog: boolean;
  requiresPrescription: boolean;
}): boolean {
  return product.hidePriceInOnlineCatalog || product.requiresPrescription;
}
