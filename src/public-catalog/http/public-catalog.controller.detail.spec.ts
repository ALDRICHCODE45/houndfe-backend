import { GetPublicProductDetailUseCase } from '../application/use-cases/get-public-product-detail.use-case';
import type { IPublicCatalogRepository } from '../application/ports/public-catalog.repository';
import type { ProductDetailWithIncludes } from '../application/mappers/public-product.mapper';
import { NotFoundException } from '@nestjs/common';

function makeDetailProduct(
  overrides: Partial<ProductDetailWithIncludes> = {},
): ProductDetailWithIncludes {
  return {
    id: 'prod-1',
    name: 'Royal Canin 13.6kg',
    description: 'Dog food',
    hasVariants: true,
    useStock: true,
    quantity: 0,
    minQuantity: 0,
    hidePriceInOnlineCatalog: false,
    requiresPrescription: false,
    category: { id: 'cat-1', name: 'Alimento Seco' },
    brand: { name: 'Royal Canin' },
    images: [
      { id: 'img-1', url: 'https://cdn.example.com/img1.jpg', isMain: true },
    ],
    priceLists: [{ priceCents: 125000 }],
    variants: [
      {
        id: 'var-1',
        name: 'Grande',
        option: 'Talla',
        value: 'G',
        quantity: 10,
        minQuantity: 2,
        images: [{ url: 'https://cdn.example.com/var1.jpg' }],
        variantPrices: [{ priceCents: 130000 }],
      },
    ],
    ...overrides,
  };
}

describe('GetPublicProductDetailUseCase', () => {
  let useCase: GetPublicProductDetailUseCase;
  let repo: { findProductById: jest.Mock };
  const tenant = { id: 'tenant-1', slug: 'centro', name: 'Sucursal Centro' };

  beforeEach(() => {
    repo = { findProductById: jest.fn() };
    useCase = new GetPublicProductDetailUseCase(
      repo as unknown as IPublicCatalogRepository,
    );
  });

  it('should return product detail with variants', async () => {
    repo.findProductById.mockResolvedValue(makeDetailProduct());

    const result = await useCase.execute('prod-1', tenant);

    expect(result.id).toBe('prod-1');
    expect(result.name).toBe('Royal Canin 13.6kg');
    expect(result.variants).toHaveLength(1);
    expect(result.rating).toBeNull();
    expect(result.featuredLabel).toBeNull();
  });

  it('should map single-entry availabilityByBranch with isSelected=true', async () => {
    repo.findProductById.mockResolvedValue(makeDetailProduct());

    const result = await useCase.execute('prod-1', tenant);

    expect(result.variants[0].availabilityByBranch).toHaveLength(1);
    expect(result.variants[0].availabilityByBranch[0]).toEqual({
      branchId: 'tenant-1',
      branchName: 'Sucursal Centro',
      branchSlug: 'centro',
      availability: 'available',
      isSelected: true,
    });
  });

  it('should throw 404 when product is not found', async () => {
    repo.findProductById.mockResolvedValue(null);

    await expect(
      useCase.execute('non-existent', tenant),
    ).rejects.toThrow(NotFoundException);
  });

  it('should not include raw quantity or cost fields in output', async () => {
    repo.findProductById.mockResolvedValue(makeDetailProduct());

    const result = await useCase.execute('prod-1', tenant);
    const keys = Object.keys(result);

    expect(keys).not.toContain('quantity');
    expect(keys).not.toContain('minQuantity');
    expect(keys).not.toContain('tenantId');
    expect(keys).not.toContain('purchaseNetCostCents');
  });

  it('should hide prices when product is prescription-required', async () => {
    repo.findProductById.mockResolvedValue(
      makeDetailProduct({ requiresPrescription: true }),
    );

    const result = await useCase.execute('prod-1', tenant);

    expect(result.price.hidden).toBe(true);
    expect(result.price.priceCents).toBeNull();
    expect(result.variants[0].price.hidden).toBe(true);
    expect(result.variants[0].price.priceCents).toBeNull();
  });
});
