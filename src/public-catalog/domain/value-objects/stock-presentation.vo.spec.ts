import {
  resolveProductStockPresentation,
  resolveVariantStockPresentation,
  type EffectiveStockPresentationConfig,
} from './stock-presentation.vo';

describe('resolveProductStockPresentation', () => {
  it('inherits tenant mode and custom quantity when product has nulls', () => {
    const result = resolveProductStockPresentation(
      {
        onlineStockPresentation: null,
        onlineStockPresentationCustomQty: null,
      },
      {
        catalogStockPresentationDefault: 'ABSTRACT_STATUS',
        catalogStockPresentationDefaultCustomQty: 10,
      },
    );
    expect(result).toEqual({
      mode: 'ABSTRACT_STATUS',
      customQuantity: 10,
    });
  });

  it('prefers the explicit product mode over the tenant default', () => {
    const result = resolveProductStockPresentation(
      {
        onlineStockPresentation: 'CUSTOM_QUANTITY',
        onlineStockPresentationCustomQty: null,
      },
      {
        catalogStockPresentationDefault: 'ABSTRACT_STATUS',
        catalogStockPresentationDefaultCustomQty: 10,
      },
    );
    expect(result.mode).toBe('CUSTOM_QUANTITY');
  });

  it('falls back to SYSTEM_STATUS when product and tenant modes are null', () => {
    const result = resolveProductStockPresentation(
      {
        onlineStockPresentation: null,
        onlineStockPresentationCustomQty: null,
      },
      {
        catalogStockPresentationDefault: null,
        catalogStockPresentationDefaultCustomQty: null,
      },
    );
    expect(result).toEqual({ mode: 'SYSTEM_STATUS', customQuantity: null });
  });

  it('inherits quantity independently: an explicit mode still falls back for quantity', () => {
    const result = resolveProductStockPresentation(
      {
        onlineStockPresentation: 'CUSTOM_QUANTITY',
        onlineStockPresentationCustomQty: null,
      },
      {
        catalogStockPresentationDefault: 'ABSTRACT_STATUS',
        catalogStockPresentationDefaultCustomQty: 10,
      },
    );
    expect(result).toEqual({ mode: 'CUSTOM_QUANTITY', customQuantity: 10 });
  });

  it('preserves an explicit custom quantity of 0 over the tenant default', () => {
    const result = resolveProductStockPresentation(
      {
        onlineStockPresentation: null,
        onlineStockPresentationCustomQty: 0,
      },
      {
        catalogStockPresentationDefault: 'CUSTOM_QUANTITY',
        catalogStockPresentationDefaultCustomQty: 10,
      },
    );
    expect(result).toEqual({ mode: 'CUSTOM_QUANTITY', customQuantity: 0 });
  });

  it('lets an explicit M5 SYSTEM_STATUS product take precedence over the tenant mode', () => {
    const result = resolveProductStockPresentation(
      {
        onlineStockPresentation: 'SYSTEM_STATUS',
        onlineStockPresentationCustomQty: null,
      },
      {
        catalogStockPresentationDefault: 'ABSTRACT_STATUS',
        catalogStockPresentationDefaultCustomQty: null,
      },
    );
    expect(result.mode).toBe('SYSTEM_STATUS');
  });

  it('resolves at read time: changing tenant defaults changes the next call', () => {
    const tenant = {
      catalogStockPresentationDefault: 'ABSTRACT_STATUS' as
        | 'ABSTRACT_STATUS'
        | 'HIDDEN',
      catalogStockPresentationDefaultCustomQty: 10,
    };
    const product = {
      onlineStockPresentation: null,
      onlineStockPresentationCustomQty: null,
    };
    const first = resolveProductStockPresentation(product, tenant);
    tenant.catalogStockPresentationDefault = 'HIDDEN';
    tenant.catalogStockPresentationDefaultCustomQty = 3;
    const second = resolveProductStockPresentation(product, tenant);
    expect(first.mode).toBe('ABSTRACT_STATUS');
    expect(first.customQuantity).toBe(10);
    expect(second).toEqual({ mode: 'HIDDEN', customQuantity: 3 });
  });

  it('does not mutate frozen inputs', () => {
    const product = Object.freeze({
      onlineStockPresentation: null,
      onlineStockPresentationCustomQty: null,
    });
    const tenant = Object.freeze({
      catalogStockPresentationDefault: 'CUSTOM_QUANTITY' as const,
      catalogStockPresentationDefaultCustomQty: 5,
    });
    const result = resolveProductStockPresentation(product, tenant);
    expect(result).toEqual({ mode: 'CUSTOM_QUANTITY', customQuantity: 5 });
    expect(product.onlineStockPresentation).toBeNull();
    expect(product.onlineStockPresentationCustomQty).toBeNull();
    expect(tenant.catalogStockPresentationDefault).toBe('CUSTOM_QUANTITY');
    expect(tenant.catalogStockPresentationDefaultCustomQty).toBe(5);
  });
});

describe('resolveVariantStockPresentation', () => {
  const productConfig: EffectiveStockPresentationConfig = {
    mode: 'CUSTOM_QUANTITY',
    customQuantity: 7,
  };

  it('inherits the resolved product config when the variant has no override', () => {
    const result = resolveVariantStockPresentation(
      {
        onlineStockPresentation: null,
        onlineStockPresentationCustomQty: null,
      },
      productConfig,
    );
    expect(result).toEqual({ mode: 'CUSTOM_QUANTITY', customQuantity: 7 });
  });

  it('uses only the variant value when the mode is explicitly overridden', () => {
    const result = resolveVariantStockPresentation(
      {
        onlineStockPresentation: 'HIDDEN',
        onlineStockPresentationCustomQty: null,
      },
      productConfig,
    );
    expect(result).toEqual({ mode: 'HIDDEN', customQuantity: null });
  });

  it('preserves an explicit variant override of 0', () => {
    const result = resolveVariantStockPresentation(
      {
        onlineStockPresentation: 'CUSTOM_QUANTITY',
        onlineStockPresentationCustomQty: 0,
      },
      productConfig,
    );
    expect(result).toEqual({ mode: 'CUSTOM_QUANTITY', customQuantity: 0 });
  });

  it('keys quantity inheritance on mode nullity, not on quantity presence', () => {
    const result = resolveVariantStockPresentation(
      {
        onlineStockPresentation: null,
        onlineStockPresentationCustomQty: 99,
      },
      productConfig,
    );
    expect(result).toEqual({ mode: 'CUSTOM_QUANTITY', customQuantity: 7 });
  });

  it('supports every presentation mode on the variant', () => {
    for (const mode of [
      'SYSTEM_STATUS',
      'ABSTRACT_STATUS',
      'CUSTOM_QUANTITY',
      'HIDDEN',
    ] as const) {
      const result = resolveVariantStockPresentation(
        {
          onlineStockPresentation: mode,
          onlineStockPresentationCustomQty: null,
        },
        productConfig,
      );
      expect(result.mode).toBe(mode);
    }
  });

  it('does not mutate frozen variant inputs', () => {
    const variant = Object.freeze({
      onlineStockPresentation: null as 'ABSTRACT_STATUS' | null,
      onlineStockPresentationCustomQty: null as number | null,
    });
    const result = resolveVariantStockPresentation(variant, productConfig);
    expect(result).toEqual({ mode: 'CUSTOM_QUANTITY', customQuantity: 7 });
    expect(variant.onlineStockPresentation).toBeNull();
    expect(variant.onlineStockPresentationCustomQty).toBeNull();
  });
});
