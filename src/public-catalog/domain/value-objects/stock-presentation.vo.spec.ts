import {
  renderStockPresentation,
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

describe('renderStockPresentation', () => {
  it('renders SYSTEM_STATUS available for positive tracked stock', () => {
    expect(
      renderStockPresentation(
        { mode: 'SYSTEM_STATUS', customQuantity: null },
        { useStock: true, quantity: 10, minQuantity: 3 },
      ),
    ).toEqual({
      mode: 'SYSTEM_STATUS',
      status: 'available',
      customQuantity: null,
    });
  });

  it('renders SYSTEM_STATUS out_of_stock for zero tracked stock', () => {
    expect(
      renderStockPresentation(
        { mode: 'SYSTEM_STATUS', customQuantity: null },
        { useStock: true, quantity: 0, minQuantity: 3 },
      ).status,
    ).toBe('out_of_stock');
  });

  it('renders HIDDEN with no status and no custom quantity', () => {
    expect(
      renderStockPresentation(
        { mode: 'HIDDEN', customQuantity: 5 },
        { useStock: true, quantity: 0, minQuantity: 3 },
      ),
    ).toEqual({ mode: 'HIDDEN', status: null, customQuantity: null });
  });

  it('renders CUSTOM_QUANTITY with null status and the configured quantity for positive stock', () => {
    expect(
      renderStockPresentation(
        { mode: 'CUSTOM_QUANTITY', customQuantity: 8 },
        { useStock: true, quantity: 10, minQuantity: 3 },
      ),
    ).toEqual({
      mode: 'CUSTOM_QUANTITY',
      status: null,
      customQuantity: 8,
    });
  });

  it('renders SYSTEM_STATUS low_stock at/below the operational threshold', () => {
    expect(
      renderStockPresentation(
        { mode: 'SYSTEM_STATUS', customQuantity: null },
        { useStock: true, quantity: 3, minQuantity: 3 },
      ).status,
    ).toBe('low_stock');
    expect(
      renderStockPresentation(
        { mode: 'SYSTEM_STATUS', customQuantity: null },
        { useStock: true, quantity: 2, minQuantity: 3 },
      ).status,
    ).toBe('low_stock');
  });

  it('renders SYSTEM_STATUS as available for untracked stock', () => {
    expect(
      renderStockPresentation(
        { mode: 'SYSTEM_STATUS', customQuantity: null },
        { useStock: false, quantity: 0, minQuantity: 0 },
      ),
    ).toEqual({
      mode: 'SYSTEM_STATUS',
      status: 'available',
      customQuantity: null,
    });
  });

  it('renders ABSTRACT_STATUS as available for positive tracked stock', () => {
    expect(
      renderStockPresentation(
        { mode: 'ABSTRACT_STATUS', customQuantity: null },
        { useStock: true, quantity: 10, minQuantity: 3 },
      ),
    ).toEqual({
      mode: 'ABSTRACT_STATUS',
      status: 'available',
      customQuantity: null,
    });
  });

  it('renders ABSTRACT_STATUS as available for low tracked stock', () => {
    expect(
      renderStockPresentation(
        { mode: 'ABSTRACT_STATUS', customQuantity: null },
        { useStock: true, quantity: 1, minQuantity: 3 },
      ),
    ).toEqual({
      mode: 'ABSTRACT_STATUS',
      status: 'available',
      customQuantity: null,
    });
  });

  it('renders ABSTRACT_STATUS as exhausted for zero tracked stock', () => {
    expect(
      renderStockPresentation(
        { mode: 'ABSTRACT_STATUS', customQuantity: null },
        { useStock: true, quantity: 0, minQuantity: 3 },
      ).status,
    ).toBe('out_of_stock');
  });

  it('renders ABSTRACT_STATUS as available for untracked stock', () => {
    expect(
      renderStockPresentation(
        { mode: 'ABSTRACT_STATUS', customQuantity: null },
        { useStock: false, quantity: 0, minQuantity: 0 },
      ).status,
    ).toBe('available');
  });

  it('renders CUSTOM_QUANTITY as out_of_stock for zero tracked stock while preserving the configured quantity', () => {
    expect(
      renderStockPresentation(
        { mode: 'CUSTOM_QUANTITY', customQuantity: 8 },
        { useStock: true, quantity: 0, minQuantity: 3 },
      ),
    ).toEqual({
      mode: 'CUSTOM_QUANTITY',
      status: 'out_of_stock',
      customQuantity: 8,
    });
  });

  it('renders CUSTOM_QUANTITY with null status for low tracked stock', () => {
    expect(
      renderStockPresentation(
        { mode: 'CUSTOM_QUANTITY', customQuantity: 8 },
        { useStock: true, quantity: 3, minQuantity: 3 },
      ).status,
    ).toBeNull();
  });

  it('renders CUSTOM_QUANTITY with null status for untracked stock and keeps the configured quantity', () => {
    expect(
      renderStockPresentation(
        { mode: 'CUSTOM_QUANTITY', customQuantity: 4 },
        { useStock: false, quantity: 0, minQuantity: 0 },
      ),
    ).toEqual({
      mode: 'CUSTOM_QUANTITY',
      status: null,
      customQuantity: 4,
    });
  });

  it('renders CUSTOM_QUANTITY preserving a configured quantity of 0 unchanged', () => {
    expect(
      renderStockPresentation(
        { mode: 'CUSTOM_QUANTITY', customQuantity: 0 },
        { useStock: true, quantity: 10, minQuantity: 3 },
      ),
    ).toEqual({
      mode: 'CUSTOM_QUANTITY',
      status: null,
      customQuantity: 0,
    });
  });

  it('renders CUSTOM_QUANTITY preserving a null configured quantity unchanged', () => {
    expect(
      renderStockPresentation(
        { mode: 'CUSTOM_QUANTITY', customQuantity: null },
        { useStock: true, quantity: 10, minQuantity: 3 },
      ),
    ).toEqual({
      mode: 'CUSTOM_QUANTITY',
      status: null,
      customQuantity: null,
    });
  });

  it.each([
    ['SYSTEM_STATUS', 'out_of_stock', null],
    ['ABSTRACT_STATUS', 'out_of_stock', null],
    ['CUSTOM_QUANTITY', 'out_of_stock', 5],
  ] as const)(
    'renders %s as out_of_stock for negative tracked stock',
    (mode, status, customQuantity) => {
      expect(
        renderStockPresentation(
          { mode, customQuantity },
          { useStock: true, quantity: -2, minQuantity: 3 },
        ),
      ).toEqual({ mode, status, customQuantity });
    },
  );

  it('renders HIDDEN with no indicator for untracked stock', () => {
    expect(
      renderStockPresentation(
        { mode: 'HIDDEN', customQuantity: 5 },
        { useStock: false, quantity: 0, minQuantity: 0 },
      ),
    ).toEqual({ mode: 'HIDDEN', status: null, customQuantity: null });
  });

  it('suppresses the configured custom quantity for non-CUSTOM modes', () => {
    for (const mode of [
      'SYSTEM_STATUS',
      'ABSTRACT_STATUS',
      'HIDDEN',
    ] as const) {
      expect(
        renderStockPresentation(
          { mode, customQuantity: 8 },
          { useStock: true, quantity: 10, minQuantity: 3 },
        ).customQuantity,
      ).toBeNull();
    }
  });

  it('renders HIDDEN with no indicator even for zero tracked stock', () => {
    expect(
      renderStockPresentation(
        { mode: 'HIDDEN', customQuantity: null },
        { useStock: true, quantity: 0, minQuantity: 3 },
      ),
    ).toEqual({ mode: 'HIDDEN', status: null, customQuantity: null });
  });

  it('echoes the effective mode for every presentation mode', () => {
    for (const mode of [
      'SYSTEM_STATUS',
      'ABSTRACT_STATUS',
      'CUSTOM_QUANTITY',
      'HIDDEN',
    ] as const) {
      expect(
        renderStockPresentation(
          { mode, customQuantity: null },
          { useStock: true, quantity: 10, minQuantity: 3 },
        ).mode,
      ).toBe(mode);
    }
  });

  it('does not mutate frozen render inputs', () => {
    const config = Object.freeze({
      mode: 'CUSTOM_QUANTITY' as const,
      customQuantity: 6,
    });
    const operational = Object.freeze({
      useStock: true,
      quantity: 0,
      minQuantity: 3,
    });
    const result = renderStockPresentation(config, operational);
    expect(result).toEqual({
      mode: 'CUSTOM_QUANTITY',
      status: 'out_of_stock',
      customQuantity: 6,
    });
    expect(config.customQuantity).toBe(6);
    expect(operational.quantity).toBe(0);
  });
});
