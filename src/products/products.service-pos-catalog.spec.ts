/**
 * ProductsService — POS Catalog Search Tests
 *
 * Tests for searchForPOS method: Prisma query generation, filters, pagination, mapping.
 */
import { ProductsService } from './products.service';
import type { IProductRepository } from './domain/product.repository';

// ── Minimal mocks ──────────────────────────────────────────────────────

function makeMockRepo(overrides: Partial<IProductRepository> = {}) {
  return {
    findById: jest.fn(),
    findBySku: jest.fn(),
    findByBarcode: jest.fn(),
    findAll: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
    isSkuTaken: jest.fn<Promise<boolean>, any>().mockResolvedValue(false),
    isBarcodeTaken: jest.fn<Promise<boolean>, any>().mockResolvedValue(false),
    ...overrides,
  } as jest.Mocked<IProductRepository>;
}

function makeMockPrisma() {
  return {
    product: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  };
}

function makeMockFilesService() {
  return {
    uploadAndRegister: jest.fn(),
    delete: jest.fn(),
    findById: jest.fn(),
    findByIds: jest.fn(),
  } as any;
}

function createService(
  repo: IProductRepository,
  prisma: ReturnType<typeof makeMockPrisma>,
) {
  return new ProductsService(repo, prisma as any, makeMockFilesService());
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('ProductsService — searchForPOS', () => {
  let repo: ReturnType<typeof makeMockRepo>;
  let prisma: ReturnType<typeof makeMockPrisma>;
  let service: ProductsService;

  beforeEach(() => {
    repo = makeMockRepo();
    prisma = makeMockPrisma();
    service = createService(repo, prisma);
  });

  it('should return paginated products with sellInPos=true', async () => {
    // Arrange
    const mockProducts = [
      {
        id: 'prod-1',
        name: 'Aspirina',
        sku: 'ASP-500',
        barcode: '7501234567890',
        unit: 'PIEZA',
        hasVariants: false,
        useStock: true,
        quantity: 120,
        minQuantity: 10,
        sellInPos: true,
        category: { id: 'cat-1', name: 'Medicamentos' },
        brand: { id: 'brand-1', name: 'Bayer' },
        images: [{ url: 'https://example.com/asp.jpg', isMain: true }],
        priceLists: [
          {
            priceCents: 5000,
            globalPriceList: { name: 'PUBLICO', isDefault: true },
          },
        ],
        variants: [],
      },
    ];

    prisma.product.findMany.mockResolvedValue(mockProducts);
    prisma.product.count.mockResolvedValue(1);

    // Act
    const result = await service.searchForPOS({ limit: 25, offset: 0 });

    // Assert
    expect(result.total).toBe(1);
    expect(result.limit).toBe(25);
    expect(result.offset).toBe(0);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('prod-1');
    expect(result.items[0].name).toBe('Aspirina');
    expect(result.items[0].mainImage).toBe('https://example.com/asp.jpg');
    expect(result.items[0].price).toEqual({
      priceCents: 5000,
      priceDecimal: 50,
      priceListName: 'PUBLICO',
    });
    expect(result.items[0].stock).toEqual({
      quantity: 120,
      minQuantity: 10,
    });
  });

  it('should filter by search query across product name, SKU, barcode', async () => {
    // Arrange
    prisma.product.findMany.mockResolvedValue([]);
    prisma.product.count.mockResolvedValue(0);

    // Act
    await service.searchForPOS({ q: 'Aspirina', limit: 25, offset: 0 });

    // Assert
    const call = prisma.product.findMany.mock.calls[0][0];
    expect(call.where.OR).toBeDefined();
    expect(call.where.OR.length).toBeGreaterThan(0);
  });

  it('should filter by categoryId when provided', async () => {
    // Arrange
    prisma.product.findMany.mockResolvedValue([]);
    prisma.product.count.mockResolvedValue(0);

    // Act
    await service.searchForPOS({
      categoryId: 'cat-1',
      limit: 25,
      offset: 0,
    });

    // Assert
    const call = prisma.product.findMany.mock.calls[0][0];
    expect(call.where.categoryId).toBe('cat-1');
  });

  it('should filter by brandId when provided', async () => {
    // Arrange
    prisma.product.findMany.mockResolvedValue([]);
    prisma.product.count.mockResolvedValue(0);

    // Act
    await service.searchForPOS({ brandId: 'brand-1', limit: 25, offset: 0 });

    // Assert
    const call = prisma.product.findMany.mock.calls[0][0];
    expect(call.where.brandId).toBe('brand-1');
  });

  it('should apply pagination with limit and offset', async () => {
    // Arrange
    prisma.product.findMany.mockResolvedValue([]);
    prisma.product.count.mockResolvedValue(60);

    // Act
    await service.searchForPOS({ limit: 25, offset: 25 });

    // Assert
    const call = prisma.product.findMany.mock.calls[0][0];
    expect(call.take).toBe(25);
    expect(call.skip).toBe(25);
  });

  it('should return product with variants when hasVariants=true', async () => {
    // Arrange
    const mockProducts = [
      {
        id: 'prod-2',
        name: 'Camisa',
        sku: null,
        barcode: null,
        unit: 'PIEZA',
        hasVariants: true,
        useStock: true,
        quantity: 0,
        minQuantity: 0,
        sellInPos: true,
        category: null,
        brand: null,
        images: [],
        priceLists: [],
        variants: [
          {
            id: 'var-1',
            name: 'Roja M',
            sku: 'CAM-R-M',
            barcode: '1234567890',
            quantity: 15,
            minQuantity: 5,
            images: [{ url: 'https://example.com/cam-r.jpg', isMain: true }],
            variantPrices: [
              {
                priceCents: 15000,
                priceList: {
                  globalPriceList: { name: 'PUBLICO', isDefault: true },
                },
              },
            ],
          },
        ],
      },
    ];

    prisma.product.findMany.mockResolvedValue(mockProducts);
    prisma.product.count.mockResolvedValue(1);

    // Act
    const result = await service.searchForPOS({ limit: 25, offset: 0 });

    // Assert
    expect(result.items[0].hasVariants).toBe(true);
    expect(result.items[0].price).toBeNull();
    expect(result.items[0].stock).toBeNull();
    expect(result.items[0].variants).toHaveLength(1);
    expect(result.items[0].variants[0].name).toBe('Roja M');
    expect(result.items[0].variants[0].mainImage).toBe(
      'https://example.com/cam-r.jpg',
    );
    expect(result.items[0].variants[0].price).toEqual({
      priceCents: 15000,
      priceDecimal: 150,
      priceListName: 'PUBLICO',
    });
  });

  it('should return null stock when useStock=false', async () => {
    // Arrange
    const mockProducts = [
      {
        id: 'prod-3',
        name: 'Service Item',
        sku: 'SRV-001',
        barcode: null,
        unit: 'SERVICIO',
        hasVariants: false,
        useStock: false,
        quantity: 0,
        minQuantity: 0,
        sellInPos: true,
        category: null,
        brand: null,
        images: [],
        priceLists: [
          {
            priceCents: 10000,
            globalPriceList: { name: 'PUBLICO', isDefault: true },
          },
        ],
        variants: [],
      },
    ];

    prisma.product.findMany.mockResolvedValue(mockProducts);
    prisma.product.count.mockResolvedValue(1);

    // Act
    const result = await service.searchForPOS({ limit: 25, offset: 0 });

    // Assert
    expect(result.items[0].stock).toBeNull();
  });

  it('should cap images array at 5 items', async () => {
    // Arrange
    const mockProducts = [
      {
        id: 'prod-4',
        name: 'Multi Image Product',
        sku: 'MIP-001',
        barcode: null,
        unit: 'PIEZA',
        hasVariants: false,
        useStock: false,
        quantity: 0,
        minQuantity: 0,
        sellInPos: true,
        category: null,
        brand: null,
        images: [
          { url: 'https://example.com/1.jpg', isMain: true },
          { url: 'https://example.com/2.jpg', isMain: false },
          { url: 'https://example.com/3.jpg', isMain: false },
          { url: 'https://example.com/4.jpg', isMain: false },
          { url: 'https://example.com/5.jpg', isMain: false },
          { url: 'https://example.com/6.jpg', isMain: false },
        ],
        priceLists: [
          {
            priceCents: 1000,
            globalPriceList: { name: 'PUBLICO', isDefault: true },
          },
        ],
        variants: [],
      },
    ];

    prisma.product.findMany.mockResolvedValue(mockProducts);
    prisma.product.count.mockResolvedValue(1);

    // Act
    const result = await service.searchForPOS({ limit: 25, offset: 0 });

    // Assert
    expect(result.items[0].images).toHaveLength(5);
  });

  it('should return default price 0 when no price list found', async () => {
    // Arrange
    const mockProducts = [
      {
        id: 'prod-5',
        name: 'No Price Product',
        sku: 'NPP-001',
        barcode: null,
        unit: 'PIEZA',
        hasVariants: false,
        useStock: false,
        quantity: 0,
        minQuantity: 0,
        sellInPos: true,
        category: null,
        brand: null,
        images: [],
        priceLists: [],
        variants: [],
      },
    ];

    prisma.product.findMany.mockResolvedValue(mockProducts);
    prisma.product.count.mockResolvedValue(1);

    // Act
    const result = await service.searchForPOS({ limit: 25, offset: 0 });

    // Assert
    expect(result.items[0].price).toEqual({
      priceCents: 0,
      priceDecimal: 0,
      priceListName: 'PUBLICO',
    });
  });
});
