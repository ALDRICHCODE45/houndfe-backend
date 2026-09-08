import {
  mapPublicAggregateVariantStockPresentation,
  mapPublicProductStockPresentation,
  mapPublicVariantStockPresentation,
  type StockPresentationMappingResult,
} from './public-stock-presentation.mapper';
import type { PublicStockPresentationDto } from '../dto/public-stock-presentation.dto';
import type {
  StockPresentationDefaults,
  StockPresentationSource,
} from '../../domain/value-objects/stock-presentation.vo';

const TENANT: StockPresentationDefaults = {
  catalogStockPresentationDefault: 'SYSTEM_STATUS',
  catalogStockPresentationDefaultCustomQty: null,
};

type ProductFixture = StockPresentationSource & {
  useStock: boolean;
  quantity: number;
  minQuantity: number;
};

function makeProduct(overrides: Partial<ProductFixture> = {}): ProductFixture {
  return {
    onlineStockPresentation: null,
    onlineStockPresentationCustomQty: null,
    useStock: true,
    quantity: 50,
    minQuantity: 5,
    ...overrides,
  };
}

function mapped(result: StockPresentationMappingResult): PublicStockPresentationDto {
  expect(result).toEqual({ kind: 'mapped', value: expect.anything() });
  return (result as Extract<StockPresentationMappingResult, { kind: 'mapped' }>).value;
}

describe('mapPublicProductStockPresentation', () => {
  it('composes tenant→product resolution with individual rendering', () => {
    const via = (overrides: Partial<ProductFixture>) =>
      mapped(mapPublicProductStockPresentation({ product: makeProduct(overrides), tenant: TENANT }));
    expect(via({})).toEqual({ mode: 'SYSTEM_STATUS', status: 'available', customQuantity: null });
    expect(via({ quantity: 5 }).status).toBe('low_stock');
    expect(via({ quantity: 0 }).status).toBe('out_of_stock');
  });

  it('renders tenant-default and explicit overrides through the domain VO', () => {
    expect(
      mapped(
        mapPublicProductStockPresentation({
          product: makeProduct({ useStock: false }),
          tenant: { catalogStockPresentationDefault: 'ABSTRACT_STATUS', catalogStockPresentationDefaultCustomQty: null },
        }),
      ),
    ).toEqual({ mode: 'ABSTRACT_STATUS', status: 'available', customQuantity: null });
    expect(
      mapped(mapPublicProductStockPresentation({ product: makeProduct({ onlineStockPresentation: 'HIDDEN' }), tenant: TENANT })),
    ).toEqual({ mode: 'HIDDEN', status: null, customQuantity: null });
    expect(
      mapped(
        mapPublicProductStockPresentation({
          product: makeProduct({
            onlineStockPresentation: 'CUSTOM_QUANTITY',
            onlineStockPresentationCustomQty: 3,
            quantity: 0,
          }),
          tenant: TENANT,
        }),
      ),
    ).toEqual({ mode: 'CUSTOM_QUANTITY', status: 'out_of_stock', customQuantity: 3 });
  });
});

describe('mapPublicVariantStockPresentation', () => {
  it('inherits the product config when the variant override is null', () => {
    expect(
      mapped(
        mapPublicVariantStockPresentation({
          product: makeProduct({ onlineStockPresentation: 'CUSTOM_QUANTITY', onlineStockPresentationCustomQty: 4 }),
          variant: { onlineStockPresentation: null, onlineStockPresentationCustomQty: null, quantity: 10, minQuantity: 2 },
          tenant: TENANT,
        }),
      ),
    ).toEqual({ mode: 'CUSTOM_QUANTITY', status: null, customQuantity: 4 });
  });

  it('applies a variant override only to that variant', () => {
    expect(
      mapped(
        mapPublicVariantStockPresentation({
          product: makeProduct({ onlineStockPresentation: 'CUSTOM_QUANTITY', onlineStockPresentationCustomQty: 4 }),
          variant: { onlineStockPresentation: 'SYSTEM_STATUS', onlineStockPresentationCustomQty: 9, quantity: 1, minQuantity: 2 },
          tenant: TENANT,
        }),
      ),
    ).toEqual({ mode: 'SYSTEM_STATUS', status: 'low_stock', customQuantity: null });
  });
});

describe('mapPublicAggregateVariantStockPresentation', () => {
  const participants = [
    { quantity: 0, minQuantity: 0 },
    { quantity: 2, minQuantity: 5 },
    { quantity: 10, minQuantity: 1 },
  ];

  it('aggregates every supplied participant with status precedence', () => {
    const input = { product: makeProduct(), tenant: TENANT, variantParticipants: participants };
    expect(mapped(mapPublicAggregateVariantStockPresentation(input)).status).toBe('available');
    expect(
      mapped(mapPublicAggregateVariantStockPresentation({ ...input, variantParticipants: participants.slice(0, 2) })).status,
    ).toBe('low_stock');
    expect(
      mapped(mapPublicAggregateVariantStockPresentation({ ...input, variantParticipants: [participants[0]] })).status,
    ).toBe('out_of_stock');
  });

  it('accepts negative finite quantities and ignores extras and ordering', () => {
    expect(
      mapped(
        mapPublicAggregateVariantStockPresentation({
          product: makeProduct(),
          tenant: TENANT,
          variantParticipants: [
            { id: 'v2', price: 100, quantity: -3, minQuantity: 0 },
            { minQuantity: 1, quantity: 4, extra: true },
          ],
        }),
      ).status,
    ).toBe('available');
  });

  it('honors product-level HIDDEN and useStock=false', () => {
    expect(
      mapped(
        mapPublicAggregateVariantStockPresentation({
          product: makeProduct({ onlineStockPresentation: 'HIDDEN' }),
          tenant: TENANT,
          variantParticipants: [participants[2]],
        }),
      ),
    ).toEqual({ mode: 'HIDDEN', status: null, customQuantity: null });
    expect(
      mapped(
        mapPublicAggregateVariantStockPresentation({
          product: makeProduct({ useStock: false }),
          tenant: TENANT,
          variantParticipants: [participants[0]],
        }),
      ).status,
    ).toBe('available');
  });

  it('never consults product quantity/minQuantity as an aggregate fallback', () => {
    expect(
      mapped(
        mapPublicAggregateVariantStockPresentation({
          product: makeProduct({ quantity: 100, minQuantity: 5 }),
          tenant: TENANT,
          variantParticipants: [participants[0]],
        }),
      ).status,
    ).toBe('out_of_stock');
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['non-array object', { quantity: 1, minQuantity: 0 }],
    ['non-array string', 'qty'],
    ['empty array', []],
    ['null participant', [null]],
    ['primitive participant', [42]],
    ['missing quantity', [{ minQuantity: 0 }]],
    ['non-number quantity', [{ quantity: '10', minQuantity: 0 }]],
    ['NaN quantity', [{ quantity: Number.NaN, minQuantity: 0 }]],
    ['Infinity quantity', [{ quantity: Number.POSITIVE_INFINITY, minQuantity: 0 }]],
    ['missing minQuantity', [{ quantity: 1 }]],
    ['NaN minQuantity', [{ quantity: 1, minQuantity: Number.NaN }]],
    ['Infinity minQuantity', [{ quantity: 1, minQuantity: Number.NEGATIVE_INFINITY }]],
  ])('rejects %s participants', (_label, candidate) => {
    expect(
      mapPublicAggregateVariantStockPresentation({
        product: makeProduct(),
        tenant: TENANT,
        variantParticipants: candidate as never,
      }),
    ).toEqual({ kind: 'invalid-participants' });
  });
});
