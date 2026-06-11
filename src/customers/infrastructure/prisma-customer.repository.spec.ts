import { Customer } from '../domain/customer.entity';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { PrismaCustomerRepository } from './prisma-customer.repository';

type MockCustomerRecord = {
  id: string;
  firstName: string;
  lastName: string | null;
  phoneCountryCode: string | null;
  phone: string | null;
  email: string | null;
  globalPriceListId: string | null;
  comments: string | null;
  preferredPaymentMethod?: string | null;
  businessName: string | null;
  fiscalZipCode: string | null;
  rfc: string | null;
  fiscalRegime: string | null;
  billingStreet: string | null;
  billingExteriorNumber: string | null;
  billingInteriorNumber: string | null;
  billingZipCode: string | null;
  billingNeighborhood: string | null;
  billingMunicipality: string | null;
  billingCity: string | null;
  billingState: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type MockTenantPrisma = {
  getClient: jest.Mock<
    {
      customer: {
        findUnique: jest.Mock<Promise<MockCustomerRecord | null>, [unknown?]>;
        findFirst: jest.Mock<Promise<MockCustomerRecord | null>, [unknown?]>;
        findMany: jest.Mock<Promise<MockCustomerRecord[]>, [unknown?]>;
        upsert: jest.Mock<Promise<MockCustomerRecord>, [unknown?]>;
        delete: jest.Mock<Promise<void>, [unknown?]>;
      };
    },
    []
  >;
  getTenantId: jest.Mock<string, []>;
  client: {
    customer: {
      findUnique: jest.Mock<Promise<MockCustomerRecord | null>, [unknown?]>;
      findFirst: jest.Mock<Promise<MockCustomerRecord | null>, [unknown?]>;
      findMany: jest.Mock<Promise<MockCustomerRecord[]>, [unknown?]>;
      upsert: jest.Mock<Promise<MockCustomerRecord>, [unknown?]>;
      delete: jest.Mock<Promise<void>, [unknown?]>;
    };
  };
};

type UpsertCustomerCall = {
  create: { tenantId: string };
};

function makeTenantPrismaMock(): MockTenantPrisma {
  const client = {
    customer: {
      findUnique: jest.fn<Promise<MockCustomerRecord | null>, [unknown?]>(),
      findFirst: jest.fn<Promise<MockCustomerRecord | null>, [unknown?]>(),
      findMany: jest.fn<Promise<MockCustomerRecord[]>, [unknown?]>(),
      upsert: jest.fn<Promise<MockCustomerRecord>, [unknown?]>(),
      delete: jest.fn<Promise<void>, [unknown?]>(),
    },
  };

  return {
    getClient: jest.fn<MockTenantPrisma['client'], []>(() => client),
    getTenantId: jest.fn<string, []>(() => 'tenant-1'),
    client,
  };
}

describe('PrismaCustomerRepository tenant scoping', () => {
  it('uses TenantPrismaService client for reads', async () => {
    const tenantPrisma = makeTenantPrismaMock();
    tenantPrisma.client.customer.findUnique.mockResolvedValue(null);

    const repo = new PrismaCustomerRepository(
      tenantPrisma as unknown as TenantPrismaService,
    );
    await repo.findById('missing-customer');

    expect(tenantPrisma.getClient).toHaveBeenCalled();
  });

  it('creates customers without requiring tenantId in payload', async () => {
    const tenantPrisma = makeTenantPrismaMock();
    const customer = Customer.create({ id: 'cust-1', firstName: 'Ada' });

    tenantPrisma.client.customer.upsert.mockResolvedValue({
      id: 'cust-1',
      firstName: 'Ada',
      lastName: null,
      phoneCountryCode: null,
      phone: null,
      email: null,
      globalPriceListId: null,
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

    const repo = new PrismaCustomerRepository(
      tenantPrisma as unknown as TenantPrismaService,
    );
    await repo.save(customer);

    const upsertCall = tenantPrisma.client.customer.upsert.mock
      .calls[0]?.[0] as UpsertCustomerCall;

    expect(upsertCall.create.tenantId).toBe('tenant-1');
  });

  it('finds customers by normalized phone within tenant scope', async () => {
    const tenantPrisma = makeTenantPrismaMock();
    tenantPrisma.client.customer.findFirst.mockResolvedValue({
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
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const repo = new PrismaCustomerRepository(
      tenantPrisma as unknown as TenantPrismaService,
    );
    const result = await repo.findByPhone('tenant-1', '52', '5512345678');

    expect(tenantPrisma.client.customer.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        phoneCountryCode: '52',
        phone: '5512345678',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(result?.toResponse()).toEqual(
      expect.objectContaining({
        id: 'cust-1',
        phoneCountryCode: '52',
        phone: '5512345678',
        preferredPaymentMethod: 'transfer',
      }),
    );
  });

  it('returns null when phone lookup does not match a customer', async () => {
    const tenantPrisma = makeTenantPrismaMock();
    tenantPrisma.client.customer.findFirst.mockResolvedValue(null);

    const repo = new PrismaCustomerRepository(
      tenantPrisma as unknown as TenantPrismaService,
    );

    await expect(
      repo.findByPhone('tenant-1', '52', '0000000000'),
    ).resolves.toBeNull();
  });
});
