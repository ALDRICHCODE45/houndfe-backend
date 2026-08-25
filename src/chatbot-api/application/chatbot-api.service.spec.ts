import { NotFoundException } from '@nestjs/common';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import { Customer } from '../../customers/domain/customer.entity';
import type { ICustomerRepository } from '../../customers/domain/customer.repository';
import type { IPublicCatalogRepository } from '../../public-catalog/application/ports/public-catalog.repository';
import type {
  ProductDetailWithIncludes,
  ProductWithIncludes,
} from '../../public-catalog/application/mappers/public-product.mapper';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { IEvaluateCartPromotionsUseCase } from '../../promotions/application/ports/evaluate-cart-promotions.port';
import type { SalesService } from '../../sales/sales.service';
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

type MockSaleRecord = {
  id: string;
  folio: string | null;
  status: string;
  paymentStatus: string | null;
  deliveryStatus: string;
  channel: string;
  totalCents: number;
  paidCents: number;
  debtCents: number;
  confirmedAt: Date | null;
  customerId: string | null;
  items: Array<{
    productId: string;
    variantId: string | null;
    productName: string;
    variantName: string | null;
    quantity: number;
    unitPriceCents: number;
  }>;
  payments: Array<{
    method: string;
    amountCents: number;
    reference: string | null;
  }>;
  shippingAddress: { street: string; zipCode: string | null } | null;
};

type MockIdempotencyRecord = {
  id: string;
  status: string;
  responseJson: unknown;
  saleId: string | null;
};

type MockPaymentDetail = {
  id: string;
  tenantId: string;
  bankName: string;
  beneficiary: string;
  clabe: string;
  accountNumber: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type MockTenantClient = {
  customerAddress: {
    findFirst: jest.Mock<Promise<MockCustomerAddress | null>, [unknown?]>;
    create: jest.Mock<Promise<{ id: string }>, [unknown?]>;
    update: jest.Mock<Promise<{ id: string }>, [unknown?]>;
  };
  saleIdempotency: {
    findUnique: jest.Mock<Promise<MockIdempotencyRecord | null>, [unknown?]>;
    upsert: jest.Mock<Promise<MockIdempotencyRecord>, [unknown?]>;
    update: jest.Mock<Promise<MockIdempotencyRecord>, [unknown?]>;
  };
  sale: {
    create: jest.Mock<Promise<MockSaleRecord>, [unknown?]>;
    findUnique: jest.Mock<Promise<MockSaleRecord | null>, [unknown?]>;
    update: jest.Mock<Promise<MockSaleRecord>, [unknown?]>;
    findMany: jest.Mock<Promise<MockSaleRecord[]>, [unknown?]>;
  };
  receiptEvidence: {
    create: jest.Mock<Promise<{ id: string; status: string }>, [unknown?]>;
  };
  // Q1 / WU1 — PaymentDetail read for the bot endpoint.
  paymentDetail: {
    findFirst: jest.Mock<Promise<MockPaymentDetail | null>, [unknown?]>;
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
  let evaluateCartPromotionsUseCase: jest.Mocked<IEvaluateCartPromotionsUseCase>;
  let salesService: jest.Mocked<Pick<SalesService, 'confirmBotSale'>>;
  // Q3 / WU2 — mock the atomic idempotency port so `registerBotSale` can
  // exercise the four outcomes (acquired / replay / conflict / in_flight)
  // without touching Prisma. Only the two new methods are stubbed here
  // because the bot path no longer calls `prisma.saleIdempotency.*`
  // directly (delegated to the repo port).
  let saleRepository: {
    acquireSaleRegistrationIdempotency: jest.Mock;
    markSaleRegistrationIdempotencySucceeded: jest.Mock;
  };
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
    evaluateCartPromotionsUseCase = {
      execute: jest.fn(),
    };
    salesService = {
      confirmBotSale: jest.fn(),
    };
    saleRepository = {
      acquireSaleRegistrationIdempotency: jest.fn(),
      markSaleRegistrationIdempotencySucceeded: jest
        .fn()
        .mockResolvedValue(undefined),
    };
    const tenantClient: MockTenantClient = {
      customerAddress: {
        findFirst: jest.fn<Promise<MockCustomerAddress | null>, [unknown?]>(),
        create: jest.fn<Promise<{ id: string }>, [unknown?]>(),
        update: jest.fn<Promise<{ id: string }>, [unknown?]>(),
      },
      saleIdempotency: {
        findUnique: jest.fn<
          Promise<MockIdempotencyRecord | null>,
          [unknown?]
        >(),
        upsert: jest.fn<Promise<MockIdempotencyRecord>, [unknown?]>(),
        update: jest.fn<Promise<MockIdempotencyRecord>, [unknown?]>(),
      },
      sale: {
        create: jest.fn<Promise<MockSaleRecord>, [unknown?]>(),
        findUnique: jest.fn<Promise<MockSaleRecord | null>, [unknown?]>(),
        update: jest.fn<Promise<MockSaleRecord>, [unknown?]>(),
        findMany: jest.fn<Promise<MockSaleRecord[]>, [unknown?]>(),
      },
      receiptEvidence: {
        create: jest.fn<Promise<{ id: string; status: string }>, [unknown?]>(),
      },
      // Q1 / WU1 — PaymentDetail read for the bot endpoint.
      paymentDetail: {
        findFirst: jest.fn<Promise<MockPaymentDetail | null>, [unknown?]>(),
      },
    };
    tenantPrisma = {
      getClient: jest.fn<MockTenantClient, []>(() => tenantClient),
      getTenantId: jest.fn<string, []>(() => 'tenant-1'),
    };
    service = new ChatbotApiService(
      repository,
      customerRepository,
      evaluateCartPromotionsUseCase,
      salesService as unknown as SalesService,
      saleRepository as never,
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

  it('delegates cart pricing evaluation and preserves fully_evaluated status', async () => {
    evaluateCartPromotionsUseCase.execute.mockResolvedValue({
      items: [
        {
          productId: 'prod-1',
          variantId: null,
          quantity: 2,
          unitPriceCents: 1000,
          originalPriceCents: 2000,
          finalPriceCents: 1800,
          appliedPromotionTitle: '10% off Royal Canin',
          discountAmountCents: 200,
        },
      ],
      promotionEvaluationStatus: 'fully_evaluated',
    });

    await expect(
      service.evaluateCart({
        items: [
          {
            productId: 'prod-1',
            variantId: null,
            quantity: 2,
            unitPriceCents: 1000,
          },
        ],
      }),
    ).resolves.toEqual({
      items: [
        {
          productId: 'prod-1',
          variantId: null,
          quantity: 2,
          unitPriceCents: 1000,
          originalPriceCents: 2000,
          finalPriceCents: 1800,
          appliedPromotionTitle: '10% off Royal Canin',
          discountAmountCents: 200,
        },
      ],
      promotionEvaluationStatus: 'fully_evaluated',
    });
    expect(evaluateCartPromotionsUseCase.execute.mock.calls[0]).toEqual([
      {
        items: [
          {
            productId: 'prod-1',
            variantId: null,
            quantity: 2,
            unitPriceCents: 1000,
          },
        ],
      },
    ]);
  });

  it('delegates cart pricing evaluation and surfaces needs_human_review status', async () => {
    evaluateCartPromotionsUseCase.execute.mockResolvedValue({
      items: [
        {
          productId: 'prod-2',
          variantId: null,
          quantity: 1,
          unitPriceCents: 2500,
          originalPriceCents: 2500,
          finalPriceCents: 2500,
          appliedPromotionTitle: null,
          discountAmountCents: 0,
        },
      ],
      promotionEvaluationStatus: 'needs_human_review',
    });

    await expect(
      service.evaluateCart({
        items: [
          {
            productId: 'prod-2',
            variantId: null,
            quantity: 1,
            unitPriceCents: 2500,
          },
        ],
      }),
    ).resolves.toEqual({
      items: [
        {
          productId: 'prod-2',
          variantId: null,
          quantity: 1,
          unitPriceCents: 2500,
          originalPriceCents: 2500,
          finalPriceCents: 2500,
          appliedPromotionTitle: null,
          discountAmountCents: 0,
        },
      ],
      promotionEvaluationStatus: 'needs_human_review',
    });
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

  // ── Bot Sale Operations (Slice 6) ───────────────────────────────────────────

  describe('registerBotSale', () => {
    const botSaleInput = {
      cashierUserId: 'user-cashier-1',
      customerId: 'cust-1',
      shippingAddressId: 'addr-1',
      items: [
        {
          productId: 'prod-1',
          variantId: 'var-1',
          productName: 'Royal Canin Mini',
          variantName: '3 kg',
          quantity: 2,
          unitPriceCents: 259900,
        },
      ],
      idempotencyKey: 'bot-order-abc-123',
    };

    it('delegates bot sale confirmation to SalesService and returns the mapped response', async () => {
      // Q3 / WU2 — first call wins, the repo returns { kind: 'acquired' },
      // the service confirms the sale, then stamps SUCCEEDED.
      saleRepository.acquireSaleRegistrationIdempotency.mockResolvedValue({
        kind: 'acquired',
        token: 'idem-1',
      });
      salesService.confirmBotSale.mockResolvedValue({
        saleId: 'sale-bot-1',
        folio: 'A-2606-000001',
        paymentStatus: 'CREDIT',
        channel: 'ONLINE',
        deliveryStatus: 'PENDING',
        totalCents: 519800,
        discountCents: 0,
        paidCents: 0,
        debtCents: 519800,
        confirmedAt: '2026-06-11T00:00:00.000Z',
      });

      const result = await service.registerBotSale(botSaleInput);

      // The acquire passes the idempotency key + the canonical
      // SHA-256 hash of the request payload (D9). We assert the key is
      // forwarded; the hash itself is deterministic on the input.
      expect(
        saleRepository.acquireSaleRegistrationIdempotency,
      ).toHaveBeenCalledWith('bot-order-abc-123', expect.any(String));
      expect(
        saleRepository.acquireSaleRegistrationIdempotency.mock
          .calls[0]?.[1] as string,
      ).toMatch(/^[0-9a-f]{64}$/);
      expect(salesService.confirmBotSale).toHaveBeenCalledTimes(1);
      expect(salesService.confirmBotSale).toHaveBeenCalledWith({
        cashierUserId: 'user-cashier-1',
        customerId: 'cust-1',
        shippingAddressId: 'addr-1',
        items: [
          {
            productId: 'prod-1',
            variantId: 'var-1',
            productName: 'Royal Canin Mini',
            variantName: '3 kg',
            quantity: 2,
            unitPriceCents: 259900,
          },
        ],
      });
      expect(
        saleRepository.markSaleRegistrationIdempotencySucceeded,
      ).toHaveBeenCalledWith(
        'idem-1',
        'sale-bot-1',
        expect.objectContaining({
          saleId: 'sale-bot-1',
          folio: 'A-2606-000001',
          paymentStatus: 'CREDIT',
          channel: 'ONLINE',
        }),
      );
      expect(result.saleId).toBe('sale-bot-1');
      expect(result.folio).toBe('A-2606-000001');
      expect(result.paymentStatus).toBe('CREDIT');
      expect(result.channel).toBe('ONLINE');
    });

    it('returns cached response without creating a duplicate sale on idempotency replay', async () => {
      // Q3 / WU2 — the repo returns { kind: 'replay', payload } when a
      // SUCCEEDED row with matching hash already exists; the service
      // MUST return that cached payload verbatim and skip
      // `confirmBotSale` entirely (preserves the existing replay
      // semantics from line ~799).
      const cached = {
        saleId: 'sale-bot-existing',
        folio: 'BOT-0001',
        paymentStatus: 'CREDIT',
        channel: 'ONLINE',
        totalCents: 519800,
        discountCents: 0,
        paidCents: 0,
        debtCents: 519800,
        deliveryStatus: 'PENDING',
      };
      saleRepository.acquireSaleRegistrationIdempotency.mockResolvedValue({
        kind: 'replay',
        payload: cached,
      });

      const result = await service.registerBotSale(botSaleInput);

      expect(salesService.confirmBotSale).not.toHaveBeenCalled();
      expect(
        saleRepository.markSaleRegistrationIdempotencySucceeded,
      ).not.toHaveBeenCalled();
      expect(result.saleId).toBe('sale-bot-existing');
    });

    // Q3 / WU2 — conflict / in_flight / order-independent hash
    // scenarios (WU2-06). The first two are wire-level rejections;
    // the third pins D9's canonical-payload contract.

    it('throws IDEMPOTENCY_KEY_CONFLICT and skips confirmBotSale when the repo returns conflict', async () => {
      saleRepository.acquireSaleRegistrationIdempotency.mockResolvedValue({
        kind: 'conflict',
      });

      await expect(service.registerBotSale(botSaleInput)).rejects.toMatchObject(
        {
          code: 'IDEMPOTENCY_KEY_CONFLICT',
        },
      );
      expect(salesService.confirmBotSale).not.toHaveBeenCalled();
      expect(
        saleRepository.markSaleRegistrationIdempotencySucceeded,
      ).not.toHaveBeenCalled();
    });

    it('throws IDEMPOTENCY_KEY_IN_FLIGHT and skips confirmBotSale when the repo returns in_flight', async () => {
      saleRepository.acquireSaleRegistrationIdempotency.mockResolvedValue({
        kind: 'in_flight',
      });

      await expect(service.registerBotSale(botSaleInput)).rejects.toMatchObject(
        {
          code: 'IDEMPOTENCY_KEY_IN_FLIGHT',
        },
      );
      expect(salesService.confirmBotSale).not.toHaveBeenCalled();
      expect(
        saleRepository.markSaleRegistrationIdempotencySucceeded,
      ).not.toHaveBeenCalled();
    });

    it('retry after the original request completed (first acquire, then replay) returns the cached response', async () => {
      // Concurrency scenario: two requests with the same key arrive
      // back-to-back. The first acquire returns 'acquired' and
      // confirms the sale; the second acquire (after SUCCEEDED is
      // stamped) returns 'replay' and serves the cached payload.
      // Verify both halves from the bot service's perspective.
      saleRepository.acquireSaleRegistrationIdempotency
        .mockResolvedValueOnce({ kind: 'acquired', token: 'idem-1' })
        .mockResolvedValueOnce({
          kind: 'replay',
          payload: {
            saleId: 'sale-bot-1',
            folio: 'A-2606-000001',
            paymentStatus: 'CREDIT',
            channel: 'ONLINE',
            deliveryStatus: 'PENDING',
            totalCents: 519800,
            discountCents: 0,
            paidCents: 0,
            debtCents: 519800,
            confirmedAt: '2026-06-11T00:00:00.000Z',
          },
        });
      salesService.confirmBotSale.mockResolvedValue({
        saleId: 'sale-bot-1',
        folio: 'A-2606-000001',
        paymentStatus: 'CREDIT',
        channel: 'ONLINE',
        deliveryStatus: 'PENDING',
        totalCents: 519800,
        discountCents: 0,
        paidCents: 0,
        debtCents: 519800,
        confirmedAt: '2026-06-11T00:00:00.000Z',
      });

      const first = await service.registerBotSale(botSaleInput);
      const second = await service.registerBotSale(botSaleInput);

      expect(first.saleId).toBe('sale-bot-1');
      expect(second.saleId).toBe('sale-bot-1');
      expect(salesService.confirmBotSale).toHaveBeenCalledTimes(1);
      expect(first).toEqual(second);
    });

    it('produces the same canonical requestHash regardless of item order (D9)', async () => {
      // Two requests with the same key + same items in different
      // order MUST hash identically so the bot retrying with
      // reordered items replays instead of conflict-ing. Display
      // names must also be ignored so catalog re-labels don't
      // change the hash.
      saleRepository.acquireSaleRegistrationIdempotency
        .mockResolvedValueOnce({ kind: 'acquired', token: 'idem-A' })
        .mockResolvedValueOnce({ kind: 'conflict' });

      const multiItemInput = {
        ...botSaleInput,
        items: [
          {
            productId: 'prod-1',
            variantId: 'var-1',
            productName: 'Royal Canin Mini',
            variantName: '3 kg',
            quantity: 2,
            unitPriceCents: 259900,
          },
          {
            productId: 'prod-2',
            variantId: null,
            productName: 'Stainless Bowl',
            variantName: null,
            quantity: 1,
            unitPriceCents: 99900,
          },
        ],
      };

      // Reordered with intentionally re-labeled display names — the
      // canonical hash must ignore both order AND productName /
      // variantName (D9).
      const reordered = {
        ...multiItemInput,
        items: [
          {
            ...multiItemInput.items[1],
            productName: 'Stainless Bowl RENAMED',
          },
          {
            ...multiItemInput.items[0],
            productName: 'Royal Canin Mini RENAMED',
            variantName: '3 kg REPACKED',
          },
        ],
      };

      salesService.confirmBotSale.mockResolvedValue({
        saleId: 'sale-bot-1',
        folio: 'A-2606-000001',
        paymentStatus: 'CREDIT',
        channel: 'ONLINE',
        deliveryStatus: 'PENDING',
        totalCents: 619700,
        discountCents: 0,
        paidCents: 0,
        debtCents: 619700,
        confirmedAt: '2026-06-11T00:00:00.000Z',
      });

      await service.registerBotSale(multiItemInput);
      // Different item order, different display names, but the
      // same core fields — the canonical hash must be byte-identical.
      await expect(service.registerBotSale(reordered)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_CONFLICT',
      });

      const firstHash =
        saleRepository.acquireSaleRegistrationIdempotency.mock.calls[0]?.[1];
      const secondHash =
        saleRepository.acquireSaleRegistrationIdempotency.mock.calls[1]?.[1];
      expect(firstHash).toBeDefined();
      expect(secondHash).toBeDefined();
      expect(firstHash).toBe(secondHash);
    });

    it('produces a different requestHash when the same key ships a different quantity (true payload mismatch)', async () => {
      // Sanity counter-test to the order-independence assertion:
      // quantity changes MUST change the hash, otherwise a retried
      // accidental cart-edit would silently replay the original
      // sale (D9 + spec "requestHash mismatch" scenario).
      saleRepository.acquireSaleRegistrationIdempotency
        .mockResolvedValueOnce({ kind: 'acquired', token: 'idem-A' })
        .mockResolvedValueOnce({ kind: 'conflict' });

      salesService.confirmBotSale.mockResolvedValue({
        saleId: 'sale-bot-1',
        folio: 'A-2606-000001',
        paymentStatus: 'CREDIT',
        channel: 'ONLINE',
        deliveryStatus: 'PENDING',
        totalCents: 519800,
        discountCents: 0,
        paidCents: 0,
        debtCents: 519800,
        confirmedAt: '2026-06-11T00:00:00.000Z',
      });

      await service.registerBotSale(botSaleInput);

      const edited = {
        ...botSaleInput,
        items: [
          {
            productId: 'prod-1',
            variantId: 'var-1',
            productName: 'Royal Canin Mini',
            variantName: '3 kg',
            quantity: 3, // was 2
            unitPriceCents: 259900,
          },
        ],
      };
      await expect(service.registerBotSale(edited)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_CONFLICT',
      });

      const firstHash =
        saleRepository.acquireSaleRegistrationIdempotency.mock.calls[0]?.[1];
      const secondHash =
        saleRepository.acquireSaleRegistrationIdempotency.mock.calls[1]?.[1];
      expect(firstHash).not.toBe(secondHash);
    });

    // Q2 / WU3-09 expectedTotalCents pass-through + replay normalization

    it('passes expectedTotalCents through to confirmBotSale (D7 re-quote guard)', async () => {
      saleRepository.acquireSaleRegistrationIdempotency.mockResolvedValue({
        kind: 'acquired',
        token: 'idem-req',
      });
      salesService.confirmBotSale.mockResolvedValue({
        saleId: 'sale-bot-1',
        folio: 'A-2606-000001',
        paymentStatus: 'CREDIT',
        channel: 'ONLINE',
        deliveryStatus: 'PENDING',
        totalCents: 1800,
        discountCents: 200,
        paidCents: 0,
        debtCents: 1800,
        confirmedAt: '2026-06-11T00:00:00.000Z',
      });

      await service.registerBotSale({
        ...botSaleInput,
        expectedTotalCents: 1800,
      });

      expect(salesService.confirmBotSale).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedTotalCents: 1800,
        }),
      );
    });

    it('propagates PROMO_RE_QUOTE rejection from confirmBotSale through to the wire (no replay normalization swallows the 409)', async () => {
      // The service MUST NOT mask engine rejections as a replay or a
      // generic 500; PROMO_RE_QUOTE bubbles up so the DomainExceptionFilter
      // renders 409 with the details spread.
      saleRepository.acquireSaleRegistrationIdempotency.mockResolvedValue({
        kind: 'acquired',
        token: 'idem-promo',
      });
      salesService.confirmBotSale.mockRejectedValue(
        new BusinessRuleViolationError(
          'Promotion re-quote required',
          'PROMO_RE_QUOTE',
          {
            recomputedTotalCents: 1800,
            expectedTotalCents: 2000,
            discountCents: 200,
          },
        ),
      );

      await expect(
        service.registerBotSale({
          ...botSaleInput,
          expectedTotalCents: 2000,
        }),
      ).rejects.toMatchObject({
        code: 'PROMO_RE_QUOTE',
        details: {
          recomputedTotalCents: 1800,
          expectedTotalCents: 2000,
          discountCents: 200,
        },
      });
      // The acquire slot is NOT stamped SUCCEEDED -- the engine raised
      // before any side effect. The next acquire for the same key will
      // return 'in_flight' (D10: no FAILED marking).
      expect(
        saleRepository.markSaleRegistrationIdempotencySucceeded,
      ).not.toHaveBeenCalled();
    });

    it('returns the engine-recomputed discountCents in the wire response on acquired (Q2 surface)', async () => {
      saleRepository.acquireSaleRegistrationIdempotency.mockResolvedValue({
        kind: 'acquired',
        token: 'idem-discount',
      });
      salesService.confirmBotSale.mockResolvedValue({
        saleId: 'sale-bot-1',
        folio: 'A-2606-000001',
        paymentStatus: 'CREDIT',
        channel: 'ONLINE',
        deliveryStatus: 'PENDING',
        totalCents: 1800,
        discountCents: 200,
        paidCents: 0,
        debtCents: 1800,
        confirmedAt: '2026-06-11T00:00:00.000Z',
      });

      const result = await service.registerBotSale(botSaleInput);

      expect(result.discountCents).toBe(200);
      expect(result.totalCents).toBe(1800);
    });

    it('normalizes a legacy cached replay (no discountCents key) with discountCents=0 (WU3-06 backward compat)', async () => {
      // Pre-WU3 cached rows lack discountCents. The service MUST
      // normalize additively so legacy responses still match the
      // current BotSaleResponse shape (design risk mitigation in tasks.md).
      const legacyCached = {
        saleId: 'sale-bot-legacy',
        folio: 'BOT-OLD-1',
        paymentStatus: 'CREDIT',
        channel: 'ONLINE',
        totalCents: 519800,
        // discountCents intentionally missing
        paidCents: 0,
        debtCents: 519800,
        deliveryStatus: 'PENDING',
        confirmedAt: '2026-05-01T00:00:00.000Z',
      };
      saleRepository.acquireSaleRegistrationIdempotency.mockResolvedValue({
        kind: 'replay',
        payload: legacyCached,
      });

      const result = await service.registerBotSale(botSaleInput);

      expect(result.saleId).toBe('sale-bot-legacy');
      expect(result.discountCents).toBe(0); // normalized to 0
      expect(result.totalCents).toBe(519800);
      expect(result.deliveryStatus).toBe('PENDING');
      expect(salesService.confirmBotSale).not.toHaveBeenCalled();
    });

    it('preserves discountCents on a current replay (does not zero out a positive value)', async () => {
      const cached = {
        saleId: 'sale-bot-current',
        folio: 'BOT-NEW-1',
        paymentStatus: 'CREDIT',
        channel: 'ONLINE',
        totalCents: 1800,
        discountCents: 200, // current shape
        paidCents: 0,
        debtCents: 1800,
        deliveryStatus: 'PENDING',
        confirmedAt: '2026-06-11T00:00:00.000Z',
      };
      saleRepository.acquireSaleRegistrationIdempotency.mockResolvedValue({
        kind: 'replay',
        payload: cached,
      });

      const result = await service.registerBotSale(botSaleInput);

      expect(result.discountCents).toBe(200);
      expect(result.totalCents).toBe(1800);
    });
  });

  describe('attachReceipt', () => {
    it('creates ReceiptEvidence with PENDING status and does not auto-mark the sale as paid', async () => {
      const client = tenantPrisma.getClient();
      client.receiptEvidence.create.mockResolvedValue({
        id: 'receipt-1',
        status: 'PENDING',
      });

      const result = await service.attachReceipt({
        saleId: 'sale-bot-1',
        mediaUrl: 'https://cdn.example.com/receipts/transfer.jpg',
        declaredAmountCents: 519800,
        declaredDate: new Date('2026-06-11T10:00:00.000Z'),
        declaredReference: 'TRF-99887',
      });

      expect(client.receiptEvidence.create).toHaveBeenCalledTimes(1);
      expect(client.receiptEvidence.create.mock.calls[0]?.[0]).toMatchObject({
        data: {
          saleId: 'sale-bot-1',
          mediaUrl: 'https://cdn.example.com/receipts/transfer.jpg',
          declaredAmountCents: 519800,
          status: 'PENDING',
        },
      });
      // Sale must NOT be updated (no auto-mark-paid)
      expect(client.sale.update).not.toHaveBeenCalled();
      expect(result.receiptId).toBe('receipt-1');
      expect(result.status).toBe('PENDING');
    });
  });

  describe('setDeliveryMetadata', () => {
    it('rejects pending-payment sales before writing delivery metadata', async () => {
      const client = tenantPrisma.getClient();
      client.sale.findUnique.mockResolvedValue({
        id: 'sale-bot-1',
        folio: 'BOT-0001',
        status: 'CONFIRMED',
        paymentStatus: 'CREDIT',
        deliveryStatus: 'PENDING',
        channel: 'ONLINE',
        totalCents: 519800,
        paidCents: 0,
        debtCents: 519800,
        confirmedAt: new Date(),
        customerId: 'cust-1',
        items: [],
        payments: [],
        shippingAddress: null,
      });

      await expect(
        service.setDeliveryMetadata({
          saleId: 'sale-bot-1',
          carrierName: 'DHL',
          trackingRef: 'DHL-1234567890',
          estimatedDeliveryAt: new Date('2026-06-20T00:00:00.000Z'),
        }),
      ).rejects.toMatchObject({
        code: 'SALE_DELIVERY_NOT_READY',
        message:
          'Delivery metadata can only be set on paid confirmed ONLINE sales before delivery',
      });

      expect(client.sale.update).not.toHaveBeenCalled();
    });

    it('updates sale with carrier name, tracking ref, and estimated delivery date', async () => {
      const client = tenantPrisma.getClient();
      client.sale.findUnique.mockResolvedValue({
        id: 'sale-bot-1',
        folio: 'BOT-0001',
        status: 'CONFIRMED',
        paymentStatus: 'PAID',
        deliveryStatus: 'PENDING',
        channel: 'ONLINE',
        totalCents: 519800,
        paidCents: 519800,
        debtCents: 0,
        confirmedAt: new Date(),
        customerId: 'cust-1',
        items: [],
        payments: [],
        shippingAddress: null,
      });
      client.sale.update.mockResolvedValue({
        id: 'sale-bot-1',
        folio: 'BOT-0001',
        status: 'CONFIRMED',
        paymentStatus: 'CREDIT',
        deliveryStatus: 'SHIPPED',
        channel: 'ONLINE',
        totalCents: 519800,
        paidCents: 0,
        debtCents: 519800,
        confirmedAt: new Date(),
        customerId: 'cust-1',
        items: [],
        payments: [],
        shippingAddress: null,
      });

      await service.setDeliveryMetadata({
        saleId: 'sale-bot-1',
        carrierName: 'DHL',
        trackingRef: 'DHL-1234567890',
        estimatedDeliveryAt: new Date('2026-06-20T00:00:00.000Z'),
      });

      expect(client.sale.update).toHaveBeenCalledTimes(1);
      expect(client.sale.findUnique).toHaveBeenCalledTimes(1);
      expect(client.sale.update.mock.calls[0]?.[0]).toMatchObject({
        where: { id: 'sale-bot-1' },
        data: { carrierName: 'DHL', trackingRef: 'DHL-1234567890' },
      });
    });
  });

  describe('getOrderHistoryByPhone', () => {
    it('returns recent confirmed ONLINE sales for a customer found by phone', async () => {
      const client = tenantPrisma.getClient();
      const existingCustomer = Customer.fromPersistence({
        id: 'cust-1',
        firstName: 'Ada',
        lastName: 'Lovelace',
        phoneCountryCode: '52',
        phone: '5512345678',
        email: null,
        preferredPaymentMethod: 'transfer',
        comments: null,
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
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      customerRepository.findByPhone.mockResolvedValue(existingCustomer);
      client.sale.findMany.mockResolvedValue([
        {
          id: 'sale-bot-1',
          folio: 'BOT-0001',
          status: 'CONFIRMED',
          paymentStatus: 'CREDIT',
          deliveryStatus: 'PENDING',
          channel: 'ONLINE',
          totalCents: 519800,
          paidCents: 0,
          debtCents: 519800,
          confirmedAt: new Date('2026-06-11T00:00:00.000Z'),
          customerId: 'cust-1',
          items: [
            {
              productId: 'prod-1',
              variantId: 'var-1',
              productName: 'Royal Canin Mini',
              variantName: '3 kg',
              quantity: 2,
              unitPriceCents: 259900,
            },
          ],
          payments: [],
          shippingAddress: null,
        },
      ]);

      const result = await service.getOrderHistoryByPhone({
        phoneCountryCode: '52',
        phone: '5512345678',
      });

      expect(customerRepository.findByPhone.mock.calls[0]).toEqual([
        'tenant-1',
        '52',
        '5512345678',
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].saleId).toBe('sale-bot-1');
      expect(result[0].totalCents).toBe(519800);
      expect(result[0].items).toHaveLength(1);
      expect(result[0].items[0].productName).toBe('Royal Canin Mini');
    });

    it('returns empty array when customer has no prior orders', async () => {
      const client = tenantPrisma.getClient();
      customerRepository.findByPhone.mockResolvedValue(null);
      client.sale.findMany.mockResolvedValue([]);

      const result = await service.getOrderHistoryByPhone({
        phoneCountryCode: '52',
        phone: '5599999999',
      });

      expect(client.sale.findMany).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });
  });

  // ── Q1 / WU1 — getActivePaymentDetail (bot read endpoint) ──────────────

  describe('getActivePaymentDetail', () => {
    it('returns the active tenant account projection', async () => {
      const client = tenantPrisma.getClient();
      const updatedAt = new Date('2026-08-24T12:00:00.000Z');
      client.paymentDetail.findFirst.mockResolvedValue({
        id: 'pd-1',
        tenantId: 'tenant-1',
        bankName: 'BBVA',
        beneficiary: 'Tienda XYZ',
        clabe: '012345678901234567',
        accountNumber: '1234567890',
        isActive: true,
        createdAt: updatedAt,
        updatedAt,
      });

      const result = await service.getActivePaymentDetail();

      expect(client.paymentDetail.findFirst).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1', isActive: true },
        orderBy: { updatedAt: 'desc' },
      });
      expect(result).toEqual({
        id: 'pd-1',
        bankName: 'BBVA',
        beneficiary: 'Tienda XYZ',
        clabe: '012345678901234567',
        accountNumber: '1234567890',
        isActive: true,
        updatedAt: '2026-08-24T12:00:00.000Z',
      });
      // tenantId is intentionally NOT exposed on the wire (admin-only).
      expect(result).not.toHaveProperty('tenantId');
    });

    it('throws NO_ACTIVE_PAYMENT_DETAIL when no active row exists', async () => {
      const client = tenantPrisma.getClient();
      client.paymentDetail.findFirst.mockResolvedValue(null);

      await expect(service.getActivePaymentDetail()).rejects.toMatchObject({
        code: 'NO_ACTIVE_PAYMENT_DETAIL',
      });
    });
  });
});
