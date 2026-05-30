import { isEffectivelyPriceHidden } from './effective-price-hidden.vo';

describe('isEffectivelyPriceHidden', () => {
  it('should return false when both flags are false', () => {
    expect(
      isEffectivelyPriceHidden({
        hidePriceInOnlineCatalog: false,
        requiresPrescription: false,
      }),
    ).toBe(false);
  });

  it('should return true when hidePriceInOnlineCatalog is true', () => {
    expect(
      isEffectivelyPriceHidden({
        hidePriceInOnlineCatalog: true,
        requiresPrescription: false,
      }),
    ).toBe(true);
  });

  it('should return true when requiresPrescription is true', () => {
    expect(
      isEffectivelyPriceHidden({
        hidePriceInOnlineCatalog: false,
        requiresPrescription: true,
      }),
    ).toBe(true);
  });

  it('should return true when both flags are true', () => {
    expect(
      isEffectivelyPriceHidden({
        hidePriceInOnlineCatalog: true,
        requiresPrescription: true,
      }),
    ).toBe(true);
  });
});
