import { NotFoundException } from '@nestjs/common';
import { ValidatePublicCartUseCase } from './validate-public-cart.use-case';
import type {
  IPublicCatalogRepository,
  PublicCartCandidate,
  ResolvedPublicCatalogContext,
} from '../ports/public-catalog.repository';

/**
 * F3.WU10 — the cart seam is independent of F3 stock presentation:
 * `PublicCartCandidate` carries no presentation fields, so no presentation
 * mode can manufacture cart availability over tracked operational zero stock.
 */

type PresentationMode =
  | 'SYSTEM_STATUS'
  | 'ABSTRACT_STATUS'
  | 'CUSTOM_QUANTITY'
  | 'HIDDEN';

const CONTEXT: ResolvedPublicCatalogContext = {
  tenantId: 'tenant-1',
  tenantSlug: 'centro',
  globalPriceListId: 'gpl-1',
  name: 'Lista pública',
  isCatalogDefault: true,
  stockPresentationDefaults: {
    catalogStockPresentationDefault: 'SYSTEM_STATUS',
    catalogStockPresentationDefaultCustomQty: null,
  },
};

const INPUT = {
  tenant: { id: 'tenant-1', slug: 'centro' },
  context: CONTEXT,
  items: [{ productId: 'prod-1', quantity: 2 }],
};

function makeCandidate(
  overrides: Partial<PublicCartCandidate> = {},
): PublicCartCandidate {
  return {
    id: 'prod-1',
    name: 'Royal Canin 13.6kg',
    type: 'PRODUCT',
    includeInOnlineCatalog: true,
    hasVariants: false,
    useStock: true,
    quantity: 0, // tracked operational zero stock
    minQuantity: 5,
    hidePriceInOnlineCatalog: false,
    requiresPrescription: false,
    images: [{ url: 'https://cdn.example.com/img1.jpg' }],
    catalogPriceLists: [],
    priceLists: [{ priceCents: 125000 }],
    variants: [],
    ...overrides,
  };
}

/**
 * Narrow runtime-contamination simulation: optimistic presentation extras the
 * use case must ignore. Deliberately does not reuse the visual mapper logic.
 */
function contaminateWithPresentation(
  mode: PresentationMode,
  candidate: PublicCartCandidate,
): PublicCartCandidate {
  return {
    ...candidate,
    onlineStockPresentation: mode,
    onlineStockPresentationCustomQty: mode === 'CUSTOM_QUANTITY' ? 25 : null,
    stockPresentation: {
      mode,
      status: mode === 'HIDDEN' ? null : 'available',
      customQuantity: mode === 'CUSTOM_QUANTITY' ? 25 : null,
    },
  } as unknown as PublicCartCandidate;
}

describe('ValidatePublicCartUseCase — presentation independence (F3.WU10)', () => {
  let mockFindCandidates: jest.Mock;
  let useCase: ValidatePublicCartUseCase;

  beforeEach(() => {
    mockFindCandidates = jest.fn().mockResolvedValue([]);
    useCase = new ValidatePublicCartUseCase({
      findPublicCartCandidates: mockFindCandidates,
    } as unknown as IPublicCatalogRepository);
  });

  it.each([
    'SYSTEM_STATUS',
    'ABSTRACT_STATUS',
    'CUSTOM_QUANTITY',
    'HIDDEN',
  ] as PresentationMode[])(
    'blocks tracked operational zero stock regardless of %s presentation',
    async (mode) => {
      mockFindCandidates.mockResolvedValue([
        contaminateWithPresentation(mode, makeCandidate()),
      ]);

      const result = await useCase.executeForContext(INPUT);

      expect(result.valid).toBe(false);
      const item = result.items[0];
      expect(item.status).toBe('BLOCKED');
      expect(item.blockingCodes).toEqual(['OUT_OF_STOCK']);
      expect(item.availability).toBe('out_of_stock');
      // Exact-context price stays authoritative; the blocked row never totals.
      expect(item.unitPriceCents).toBe(125000);
      expect(item.lineTotalCents).toBe(250000);
      expect(result.totalCents).toBe(0);
    },
  );

  it('keeps useStock=false with operational quantity zero VALID and available', async () => {
    mockFindCandidates.mockResolvedValue([
      makeCandidate({ useStock: false, quantity: 0 }),
    ]);

    const result = await useCase.executeForContext(INPUT);

    expect(result.valid).toBe(true);
    const item = result.items[0];
    expect(item.status).toBe('VALID');
    expect(item.blockingCodes).toEqual([]);
    expect(item.availability).toBe('available');
    expect(result.totalCents).toBe(250000);
  });

  it('keeps operational OUT_OF_STOCK under hidden-price precedence with null numeric fields and null totals', async () => {
    mockFindCandidates.mockResolvedValue([
      makeCandidate({ hidePriceInOnlineCatalog: true }),
    ]);

    const result = await useCase.executeForContext(INPUT);

    expect(result.valid).toBe(false);
    const item = result.items[0];
    expect(item.status).toBe('BLOCKED');
    // Hidden price bypasses the allowlist/positive-price checks; stock stays
    // independent and still blocks.
    expect(item.blockingCodes).toEqual(['OUT_OF_STOCK']);
    expect(item.warnings).toEqual(['OUT_OF_STOCK', 'PRICE_HIDDEN']);
    expect(item.unitPriceCents).toBeNull();
    expect(item.lineTotalCents).toBeNull();
    expect(item.priceHidden).toBe(true);
    expect(item.availability).toBe('out_of_stock');
    expect(result.totalCents).toBeNull();
  });

  it('performs exactly one candidate read with the resolved tenant/context and de-duplicated requested IDs', async () => {
    // No inventory writer exists on the cart dependency surface; the mock
    // deliberately stops here so absence of writes is structural.
    mockFindCandidates.mockResolvedValue([]);

    await useCase.executeForContext({
      tenant: { id: 'tenant-1', slug: 'centro' },
      context: CONTEXT,
      items: [
        { productId: 'prod-1', variantId: 'var-1', quantity: 1 },
        { productId: 'prod-1', variantId: 'var-1', quantity: 2 },
        { productId: 'prod-2', quantity: 1 },
      ],
    });

    expect(mockFindCandidates).toHaveBeenCalledTimes(1);
    expect(mockFindCandidates).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      context: CONTEXT,
      productIds: ['prod-1', 'prod-2'],
      variantIds: ['var-1'],
    });
  });

  it('fails closed on tenant/context mismatch before any repository access', async () => {
    await expect(
      useCase.executeForContext({
        tenant: { id: 'tenant-other', slug: 'centro' },
        context: CONTEXT,
        items: INPUT.items,
      }),
    ).rejects.toThrow(NotFoundException);
    expect(mockFindCandidates).not.toHaveBeenCalled();
  });
});
