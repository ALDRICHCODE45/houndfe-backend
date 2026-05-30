import {
  ListPublicProductsUseCase,
  type ListProductsInput,
} from '../application/use-cases/list-public-products.use-case';
import type { IPublicCatalogRepository } from '../application/ports/public-catalog.repository';
import type { ProductWithIncludes } from '../application/mappers/public-product.mapper';

function makeProduct(id: string, overrides: Partial<ProductWithIncludes> = {}): ProductWithIncludes {
  return {
    id,
    name: `Product ${id}`,
    description: null,
    hasVariants: false,
    useStock: true,
    quantity: 50,
    minQuantity: 5,
    hidePriceInOnlineCatalog: false,
    requiresPrescription: false,
    category: { id: 'cat-1', name: 'Alimento' },
    brand: { name: 'Brand' },
    images: [{ url: 'https://cdn.example.com/img.jpg' }],
    priceLists: [{ priceCents: 100000 }],
    variants: [],
    ...overrides,
  };
}

describe('ListPublicProductsUseCase', () => {
  let useCase: ListPublicProductsUseCase;
  let repo: {
    findProducts: jest.Mock;
    findCategoryFacets: jest.Mock;
  };

  beforeEach(() => {
    repo = {
      findProducts: jest.fn(),
      findCategoryFacets: jest.fn(),
    };
    useCase = new ListPublicProductsUseCase(
      repo as unknown as IPublicCatalogRepository,
    );
  });

  const defaultInput: ListProductsInput = {
    sort: 'newest',
    page: 1,
    limit: 20,
  };

  it('should return paginated products with meta and facets', async () => {
    repo.findProducts.mockResolvedValue({
      items: [makeProduct('p1'), makeProduct('p2')],
      total: 42,
    });
    repo.findCategoryFacets.mockResolvedValue([
      { id: 'cat-1', name: 'Alimento', count: 30 },
    ]);

    const result = await useCase.execute(defaultInput);

    expect(result.items).toHaveLength(2);
    expect(result.meta).toEqual({
      page: 1,
      limit: 20,
      total: 42,
      totalPages: 3,
    });
    expect(result.facets.categories).toHaveLength(1);
  });

  it('should pass filter params to repository', async () => {
    repo.findProducts.mockResolvedValue({ items: [], total: 0 });
    repo.findCategoryFacets.mockResolvedValue([]);

    await useCase.execute({
      q: 'royal',
      categoryId: 'cat-uuid',
      sort: 'price_asc',
      page: 2,
      limit: 10,
    });

    expect(repo.findProducts).toHaveBeenCalledWith({
      q: 'royal',
      categoryId: 'cat-uuid',
      sort: 'price_asc',
      page: 2,
      limit: 10,
    });
  });

  it('should return empty items and valid meta when no matches', async () => {
    repo.findProducts.mockResolvedValue({ items: [], total: 0 });
    repo.findCategoryFacets.mockResolvedValue([]);

    const result = await useCase.execute(defaultInput);

    expect(result.items).toEqual([]);
    expect(result.meta.total).toBe(0);
    expect(result.meta.totalPages).toBe(0);
  });

  it('should map products through whitelist mapper (no raw fields)', async () => {
    repo.findProducts.mockResolvedValue({
      items: [makeProduct('p1')],
      total: 1,
    });
    repo.findCategoryFacets.mockResolvedValue([]);

    const result = await useCase.execute(defaultInput);
    const item = result.items[0];

    expect(item).toHaveProperty('id');
    expect(item).toHaveProperty('price');
    expect(item).toHaveProperty('availability');
    expect(item).not.toHaveProperty('quantity');
    expect(item).not.toHaveProperty('minQuantity');
    expect(item).not.toHaveProperty('tenantId');
    expect(item.rating).toBeNull();
    expect(item.featuredLabel).toBeNull();
  });

  it('should calculate totalPages correctly for edge case', async () => {
    repo.findProducts.mockResolvedValue({ items: [], total: 21 });
    repo.findCategoryFacets.mockResolvedValue([]);

    const result = await useCase.execute({ ...defaultInput, limit: 10 });
    expect(result.meta.totalPages).toBe(3);
  });

  it('should accept rating_desc sort and fall back to relevance behavior', async () => {
    repo.findProducts.mockResolvedValue({
      items: [makeProduct('p1')],
      total: 1,
    });
    repo.findCategoryFacets.mockResolvedValue([]);

    // rating_desc is accepted (no 400) and falls back to relevance sort
    const result = await useCase.execute({
      ...defaultInput,
      sort: 'rating_desc',
    });

    expect(result.items).toHaveLength(1);
    // repo should receive 'rating_desc' — the repo maps it to relevance orderBy internally
    expect(repo.findProducts).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'rating_desc' }),
    );
  });
});

describe('ListProductsQueryDto validation (CRITICAL-02 regression)', () => {
  // Test at DTO validation layer — rating_desc must be accepted, not 400
  it('should accept rating_desc as a valid sort value', async () => {
    const { validate } = require('class-validator');
    const { plainToInstance } = require('class-transformer');
    const { ListProductsQueryDto } = require('./request-dto/list-products-query.dto');

    const dto = plainToInstance(ListProductsQueryDto, { sort: 'rating_desc' });
    const errors = await validate(dto);
    const sortErrors = errors.filter((e: any) => e.property === 'sort');

    expect(sortErrors).toHaveLength(0);
  });

  it('should still reject invalid sort values', async () => {
    const { validate } = require('class-validator');
    const { plainToInstance } = require('class-transformer');
    const { ListProductsQueryDto } = require('./request-dto/list-products-query.dto');

    const dto = plainToInstance(ListProductsQueryDto, { sort: 'invalid_sort' });
    const errors = await validate(dto);
    const sortErrors = errors.filter((e: any) => e.property === 'sort');

    expect(sortErrors).toHaveLength(1);
  });
});
