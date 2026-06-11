import { NotFoundException } from '@nestjs/common';
import { Customer } from '../../customers/domain/customer.entity';
import type { ICustomerRepository } from '../../customers/domain/customer.repository';
import type { IPublicCatalogRepository } from '../../public-catalog/application/ports/public-catalog.repository';
import type {
  ProductDetailWithIncludes,
  ProductWithIncludes,
} from '../../public-catalog/application/mappers/public-product.mapper';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { ChatbotApiService } from './chatbot-api.service';

type MockCustomerAddress = {
  id: string;
  label?: string | null;
  street?: string;
  exteriorNumber?: string | null;
  interiorNumber?: string | null;
  zipCode?: string | null;
  neighborhood?: string | null;
  municipality?: string | null;
  city?: string | null;
  state?: string | null;
  visualReferences?: string | null;
  carrierPhone?: string | null;
};

type MockTenantClient = {
  customerAddress: {
    findFirst: jest.Mock<Promise<MockCustomerAddress | null>, [unknown?]>;
    create: jest.Mock<Promise<{ id: string }>, [unknown?]>;
    update: jest.Mock<Promise<{ id: string }>, [unknown?]>;
  };
};

type MockTenantPrisma = {
  getClient: jest.Mock<MockTenantClient, []>;
  getTenantId: jest.Mock<string, []>;
};

type CreateAddressCall = {
  data: {
    tenantId: string;
    label: string | null;
    street: string;
    zipCode: string | null;
    visualReferences: string | null;
    carrierPhone: string | null;
  };
};

type UpdateAddressCall = {
  where: { id: string };
  data: { label: string | null; visualReferences: string | null };
};

function makeCatalogProduct(
  overrides: Partial<ProductWithIncludes> = {},
): ProductWithIncludes {
  return {
    id: 'prod-1',
    name: 'Royal Canin Mini Adult',
    description: 'Dry food for small dogs',
    hasVariants: true,
    useStock: true,
    quantity: 12,
    minQuantity: 3,
    hidePriceInOnlineCatalog: false,
    requiresPrescription: false,
    category: { id: 'cat-1', name: 'Food' },
    brand: { name: 'Royal Canin' },
    images: [{ url: 'https://cdn.example.com/main.jpg' }],
    priceLists: [{ priceCents: 259900 }],
    variants: [
      {
        id: 'var-1',
        name: '3 kg',
        option: 'Weight',
        value: '3kg',
        quantity: 2,
        minQuantity: 2,
        variantPrices: [{ priceCents: 249900 }],
      },
      {
        id: 'var-2',
        name: '8 kg',
        option: 'Weight',
        value: '8kg',
        quantity: 7,
        minQuantity: 2,
        variantPrices: [{ priceCents: 499900 }],
      },
    ],
    ...overrides,
  };
}

function makeDetailProduct(
  overrides: Partial<ProductDetailWithIncludes> = {},
): ProductDetailWithIncludes {
  return {
    id: 'prod-1',
    name: 'Royal Canin Mini Adult',
    description: 'Dry food for small dogs',
    hasVariants: true,
    useStock: true,
    quantity: 0,
    minQuantity: 0,
    hidePriceInOnlineCatalog: false,
    requiresPrescription: false,
    category: { id: 'cat-1', name: 'Food' },
    brand: { name: 'Royal Canin' },
    images: [
      { id: 'img-1', url: 'https://cdn.example.com/main.jpg', isMain: true },
    ],
    priceLists: [{ priceCents: 259900 }],
    variants: [
      {
        id: 'var-1',
        name: '3 kg',
        option: 'Weight',
        value: '3kg',
        quantity: 0,
        minQuantity: 1,
        images: [{ url: 'https://cdn.example.com/var-1.jpg' }],
        variantPrices: [{ priceCents: 249900 }],
      },
    ],
    ...overrides,
  };
}

describe('ChatbotApiService', () => {
  let repository: jest.Mocked<IPublicCatalogRepository>;
  let customerRepository: jest.Mocked<ICustomerRepository>;
  let tenantPrisma: MockTenantPrisma;
  let service: ChatbotApiService;

  beforeEach(() => {
    repository = {
      findActiveBranches: jest.fn(),
      findProducts: jest.fn(),
      findCategoryFacets: jest.fn(),
      findProductById: jest.fn(),
    };
    customerRepository = {
      findById: jest.fn(),
      findByPhone: jest.fn(),
      findAll: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
    };
    const tenantClient: MockTenantClient = {
      customerAddress: {
        findFirst: jest.fn<Promise<MockCustomerAddress | null>, [unknown?]>(),
        create: jest.fn<Promise<{ id: string }>, [unknown?]>(),
        update: jest.fn<Promise<{ id: string }>, [unknown?]>(),
      },
    };
    tenantPrisma = {
      getClient: jest.fn<MockTenantClient, []>(() => tenantClient),
      getTenantId: jest.fn<string, []>(() => 'tenant-1'),
    };
    service = new ChatbotApiService(
      repository,
      customerRepository,
      tenantPrisma as unknown as TenantPrismaService,
    );
  });

  it('returns safe catalog projections with promotion placeholder, stock summary, and package data', async () => {
    repository.findProducts.mockResolvedValue({
      items: [makeCatalogProduct()],
      total: 1,
    });

    const result = await service.searchCatalog({ q: 'royal', limit: 5 });

    expect(repository.findProducts.mock.calls).toEqual([
      [
        {
          q: 'royal',
          sort: 'relevance',
          page: 1,
          limit: 5,
        },
      ],
    ]);
    expect(result).toEqual([
      {
        productId: 'prod-1',
        name: 'Royal Canin Mini Adult',
        brand: 'Royal Canin',
        imageUrl: 'https://cdn.example.com/main.jpg',
        description: 'Dry food for small dogs',
        price: {
          priceCents: 259900,
          fromPriceCents: 249900,
          promoPriceCents: null,
          promotionEvaluationStatus: 'needs_human_review',
        },
        stock: {
          status: 'available',
          quantity: 12,
        },
        packageInfo: {
          weightGrams: null,
          dimensions: null,
        },
        variants: [
          {
            variantId: 'var-1',
            name: '3 kg',
            option: 'Weight',
            value: '3kg',
            priceCents: 249900,
            stock: { status: 'low_stock', quantity: 2 },
          },
          {
            variantId: 'var-2',
            name: '8 kg',
            option: 'Weight',
            value: '8kg',
            priceCents: 499900,
            stock: { status: 'available', quantity: 7 },
          },
        ],
      },
    ]);
    expect(result[0]).not.toHaveProperty('tenantId');
    expect(result[0]).not.toHaveProperty('purchaseNetCostCents');
    expect(result[0]).not.toHaveProperty('purchaseGrossCostCents');
  });

  it('returns an empty array when no catalog items match the search', async () => {
    repository.findProducts.mockResolvedValue({ items: [], total: 0 });

    await expect(
      service.searchCatalog({ q: 'missing', limit: 10 }),
    ).resolves.toEqual([]);
  });

  it('returns out_of_stock with quantity 0 for zero-stock products', async () => {
    repository.findProductById.mockResolvedValue(
      makeDetailProduct({
        hasVariants: false,
        quantity: 0,
        minQuantity: 1,
        variants: [],
      }),
    );

    await expect(service.checkStock('prod-1')).resolves.toEqual({
      productId: 'prod-1',
      name: 'Royal Canin Mini Adult',
      stock: { status: 'out_of_stock', quantity: 0 },
      variants: [],
    });
  });

  it('returns not_managed stock when the product does not use stock tracking', async () => {
    repository.findProductById.mockResolvedValue(
      makeDetailProduct({
        useStock: false,
        quantity: 0,
        variants: [
          {
            id: 'var-1',
            name: '3 kg',
            option: 'Weight',
            value: '3kg',
            quantity: 0,
            minQuantity: 1,
            images: [],
            variantPrices: [{ priceCents: 249900 }],
          },
        ],
      }),
    );

    await expect(service.checkStock('prod-1')).resolves.toEqual({
      productId: 'prod-1',
      name: 'Royal Canin Mini Adult',
      stock: { status: 'not_managed', quantity: null },
      variants: [
        {
          variantId: 'var-1',
          name: '3 kg',
          option: 'Weight',
          value: '3kg',
          stock: { status: 'not_managed', quantity: null },
        },
      ],
    });
  });

  it('throws not found when the product does not exist in branch scope', async () => {
    repository.findProductById.mockResolvedValue(null);

    await expect(service.checkStock('missing-product')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('returns a returning customer profile by normalized WhatsApp phone', async () => {
    const addressClient = tenantPrisma.getClient();
    customerRepository.findByPhone.mockResolvedValue(
      Customer.fromPersistence({
        id: 'cust-1',
        firstName: 'Ada',
        lastName: 'Lovelace',
        phoneCountryCode: '52',
        phone: '5512345678',
        email: null,
        globalPriceListId: null,
        comments: null,
        preferredPaymentMethod: 'transfer',
        businessName: null,
        fiscalZipCode: null,
        rfc: null,
        fiscalRegime: null,
        billingStreet: null,
        billingExteriorNumber: null,
        billingInteriorNumber: null,
        billingZipCode: null,
        billingNeighborhood: null,
        billingMunicipality: null,
        billingCity: null,
        billingState: null,
        createdAt: new Date('2026-06-11T00:00:00.000Z'),
        updatedAt: new Date('2026-06-11T00:00:00.000Z'),
      }),
    );
    addressClient.customerAddress.findFirst.mockResolvedValue({
      id: 'addr-1',
      label: 'Home',
      street: 'Evergreen 742',
      exteriorNumber: '742',
      interiorNumber: null,
      zipCode: '01234',
      neighborhood: 'Centro',
      municipality: 'Benito Juarez',
      city: 'CDMX',
      state: 'Ciudad de México',
      visualReferences: 'Blue gate',
      carrierPhone: '5511223344',
    });

    await expect(
      service.findCustomerByPhone({
        phoneCountryCode: '+52',
        phone: '55 1234 5678',
      }),
    ).resolves.toEqual({
      found: true,
      customer: {
        customerId: 'cust-1',
        firstName: 'Ada',
        lastName: 'Lovelace',
        phoneCountryCode: '52',
        phone: '5512345678',
        preferredPaymentMethod: 'transfer',
        address: {
          id: 'addr-1',
          label: 'Home',
          street: 'Evergreen 742',
          exteriorNumber: '742',
          interiorNumber: null,
          zipCode: '01234',
          neighborhood: 'Centro',
          municipality: 'Benito Juarez',
          city: 'CDMX',
          state: 'Ciudad de México',
          visualReferences: 'Blue gate',
          carrierPhone: '5511223344',
        },
      },
    });
    expect(customerRepository.findByPhone.mock.calls[0]).toEqual([
      'tenant-1',
      '52',
      '5512345678',
    ]);
  });

  it('returns a customer-not-found payload when the WhatsApp phone has no profile', async () => {
    customerRepository.findByPhone.mockResolvedValue(null);

    await expect(
      service.findCustomerByPhone({
        phoneCountryCode: '52',
        phone: '0000000000',
      }),
    ).resolves.toEqual({ found: false, customer: null });
  });

  it('creates a new customer profile with delivery metadata when the phone is new', async () => {
    const addressClient = tenantPrisma.getClient();
    customerRepository.findByPhone.mockResolvedValue(null);
    customerRepository.save.mockImplementation((customer) =>
      Promise.resolve(customer),
    );
    addressClient.customerAddress.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'addr-1',
        label: 'Home',
        street: 'Evergreen 742',
        exteriorNumber: '742',
        interiorNumber: null,
        zipCode: '01234',
        neighborhood: 'Centro',
        municipality: 'Benito Juarez',
        city: 'CDMX',
        state: 'Ciudad de México',
        visualReferences: 'Blue gate',
        carrierPhone: '5511223344',
      });
    addressClient.customerAddress.create.mockResolvedValue({ id: 'addr-1' });

    const result = await service.upsertCustomerProfile({
      firstName: '  Ada ',
      lastName: ' Lovelace ',
      phoneCountryCode: '+52',
      phone: '55 1234 5678',
      preferredPaymentMethod: 'transfer',
      address: {
        label: 'Home',
        street: ' Evergreen 742 ',
        exteriorNumber: '742',
        zipCode: '01234',
        neighborhood: 'Centro',
        municipality: 'Benito Juarez',
        city: 'CDMX',
        state: 'Ciudad de México',
        visualReferences: 'Blue gate',
        carrierPhone: '55 11 22 33 44',
      },
    });

    expect(customerRepository.save.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        firstName: 'Ada',
        lastName: 'Lovelace',
        phoneCountryCode: '52',
        phone: '5512345678',
        preferredPaymentMethod: 'transfer',
      }),
    );
    const createCall = addressClient.customerAddress.create.mock
      .calls[0]?.[0] as CreateAddressCall;
    expect(createCall.data.tenantId).toBe('tenant-1');
    expect(createCall.data.label).toBe('Home');
    expect(createCall.data.street).toBe('Evergreen 742');
    expect(createCall.data.zipCode).toBe('01234');
    expect(createCall.data.visualReferences).toBe('Blue gate');
    expect(createCall.data.carrierPhone).toBe('5511223344');
    expect(result.status).toBe('created');
    expect(result.customer.firstName).toBe('Ada');
    expect(result.customer.preferredPaymentMethod).toBe('transfer');
  });

  it('updates an existing customer profile and reuses the saved address', async () => {
    const addressClient = tenantPrisma.getClient();
    const existingCustomer = Customer.fromPersistence({
      id: 'cust-1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      phoneCountryCode: '52',
      phone: '5512345678',
      email: null,
      globalPriceListId: null,
      comments: null,
      preferredPaymentMethod: 'cash',
      businessName: null,
      fiscalZipCode: null,
      rfc: null,
      fiscalRegime: null,
      billingStreet: null,
      billingExteriorNumber: null,
      billingInteriorNumber: null,
      billingZipCode: null,
      billingNeighborhood: null,
      billingMunicipality: null,
      billingCity: null,
      billingState: null,
      createdAt: new Date('2026-06-11T00:00:00.000Z'),
      updatedAt: new Date('2026-06-11T00:00:00.000Z'),
    });
    customerRepository.findByPhone.mockResolvedValue(existingCustomer);
    customerRepository.save.mockImplementation((customer) =>
      Promise.resolve(customer),
    );
    addressClient.customerAddress.findFirst
      .mockResolvedValueOnce({ id: 'addr-1' })
      .mockResolvedValueOnce({
        id: 'addr-1',
        label: 'Office',
        street: 'Insurgentes 100',
        exteriorNumber: '100',
        interiorNumber: '3B',
        zipCode: '06700',
        neighborhood: 'Roma Norte',
        municipality: 'Cuauhtemoc',
        city: 'CDMX',
        state: 'Ciudad de México',
        visualReferences: 'Ring twice',
        carrierPhone: '5510000000',
      });
    addressClient.customerAddress.update.mockResolvedValue({ id: 'addr-1' });

    const result = await service.upsertCustomerProfile({
      firstName: 'Ada',
      lastName: 'Byron',
      phoneCountryCode: '52',
      phone: '5512345678',
      preferredPaymentMethod: 'transfer',
      address: {
        label: 'Office',
        street: 'Insurgentes 100',
        exteriorNumber: '100',
        interiorNumber: '3B',
        zipCode: '06700',
        neighborhood: 'Roma Norte',
        municipality: 'Cuauhtemoc',
        city: 'CDMX',
        state: 'Ciudad de México',
        visualReferences: 'Ring twice',
        carrierPhone: '5510000000',
      },
    });

    expect(customerRepository.save.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        id: 'cust-1',
        lastName: 'Byron',
        preferredPaymentMethod: 'transfer',
      }),
    );
    const updateCall = addressClient.customerAddress.update.mock
      .calls[0]?.[0] as UpdateAddressCall;
    expect(updateCall.where.id).toBe('addr-1');
    expect(updateCall.data.label).toBe('Office');
    expect(updateCall.data.visualReferences).toBe('Ring twice');
    expect(result.status).toBe('updated');
  });
});
