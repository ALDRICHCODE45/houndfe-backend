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

describe('PrismaCustomerRepository.delete lock order (customer-pets / T3)', () => {
  function deleteHarness() {
    const calls: string[] = [];
    const queryRaw = jest.fn((strings: TemplateStringsArray) => {
      const sql = strings.join('?').replace(/\s+/g, ' ').trim();
      calls.push(
        sql.includes('FROM customers')
          ? 'lock customer'
          : sql.includes('FROM sales')
            ? 'lock sales'
            : sql.includes('FROM customer_pets')
              ? 'lock pets'
              : sql,
      );
      return Promise.resolve([]);
    });
    const client = {
      $queryRaw: queryRaw,
      backorder: {
        findFirst: jest.fn(() => {
          calls.push('backorder guard');
          return Promise.resolve(null);
        }),
        deleteMany: jest.fn(() => {
          calls.push('delete terminal backorders');
          return Promise.resolve({ count: 0 });
        }),
      },
      customer: {
        delete: jest.fn(() => {
          calls.push('delete customer');
          return Promise.resolve();
        }),
      },
    };
    const tenantPrisma = {
      getTenantId: () => 'tenant-1',
      getClient: () => client,
      runInTransaction: jest.fn((work: () => Promise<unknown>) => work()),
    };
    return {
      calls,
      client,
      repo: new PrismaCustomerRepository(
        tenantPrisma as unknown as TenantPrismaService,
      ),
    };
  }

  it('locks the customer, then its sale rows, then its pets (id order, tenant-qualified) before anything is deleted', async () => {
    const { repo, calls, client } = deleteHarness();

    await repo.delete('cust-1');

    expect(calls).toEqual([
      'lock customer',
      'lock sales',
      'lock pets',
      'backorder guard',
      'delete terminal backorders',
      'delete customer',
    ]);
    const [sales, pets] = client.$queryRaw.mock.calls.slice(
      1,
    ) as unknown as Array<[TemplateStringsArray, ...unknown[]]>;
    for (const [strings, ...values] of [sales, pets]) {
      const sql = strings.join('?');
      expect(sql).toContain('ORDER BY id');
      expect(sql).toContain('FOR UPDATE');
      expect(values).toEqual(['cust-1', 'tenant-1']);
    }
  });

  it('keeps the backorder guard: an active backorder refuses the delete after the locks and deletes nothing', async () => {
    const { repo, calls, client } = deleteHarness();
    client.backorder.findFirst.mockImplementationOnce(() => {
      calls.push('backorder guard');
      return Promise.resolve({ id: 'bo-1' } as never);
    });

    await expect(repo.delete('cust-1')).rejects.toThrow();

    expect(client.customer.delete).not.toHaveBeenCalled();
    expect(client.backorder.deleteMany).not.toHaveBeenCalled();
  });
});

describe('PrismaCustomerRepository isTrusted (customers-listing T4, contract §6.1)', () => {
  type UpsertArgs = {
    update: Record<string, unknown>;
    create: Record<string, unknown>;
  };

  const record = (isTrusted: boolean) => ({
    id: 'cust-1',
    firstName: 'Ada',
    lastName: null,
    phoneCountryCode: null,
    phone: null,
    email: null,
    globalPriceListId: null,
    comments: null,
    preferredPaymentMethod: null,
    isTrusted,
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

  function harness(stored: boolean) {
    const tenantPrisma = makeTenantPrismaMock();
    tenantPrisma.client.customer.findUnique.mockResolvedValue(record(stored));
    tenantPrisma.client.customer.upsert.mockResolvedValue(record(stored));
    const repo = new PrismaCustomerRepository(
      tenantPrisma as unknown as TenantPrismaService,
    );
    const upsertArgs = () =>
      tenantPrisma.client.customer.upsert.mock.calls[0]?.[0] as UpsertArgs;
    return { repo, upsertArgs };
  }

  it('maps the stored column into the entity', async () => {
    const { repo } = harness(true);
    const customer = await repo.findById('cust-1');
    expect(customer?.isTrusted).toBe(true);
    expect(customer?.isTrustedDirty).toBe(false);
  });

  it('a loaded customer saved without touching isTrusted does NOT write the column (chatbot upsert path)', async () => {
    const { repo, upsertArgs } = harness(true);
    const customer = (await repo.findById('cust-1'))!;
    customer.preferredPaymentMethod = 'transfer';

    await repo.save(customer);

    expect(upsertArgs().update).not.toHaveProperty('isTrusted');
    expect(upsertArgs().update).toMatchObject({
      preferredPaymentMethod: 'transfer',
    });
  });

  it('writes the column once isTrusted is set', async () => {
    const { repo, upsertArgs } = harness(true);
    const customer = (await repo.findById('cust-1'))!;
    customer.isTrusted = false;

    await repo.save(customer);

    expect(upsertArgs().update).toMatchObject({ isTrusted: false });
  });

  it('a new customer is created with isTrusted false', async () => {
    const { repo, upsertArgs } = harness(false);
    await repo.save(Customer.create({ id: 'cust-1', firstName: 'Ada' }));
    expect(upsertArgs().create).toMatchObject({ isTrusted: false });
  });
});
