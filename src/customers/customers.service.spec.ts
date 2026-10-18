import { CustomersService } from './customers.service';
import { Customer } from './domain/customer.entity';
import type { PrismaService } from '../shared/prisma/prisma.service';
import type { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';

function makeCustomerRecord(id: string) {
  const now = new Date();
  return {
    id,
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
    createdAt: now,
    updatedAt: now,
  };
}

function makeService() {
  const tenantClient = {
    customer: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    customerAddress: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };

  const customerRepo = {
    findById: jest.fn(),
    findAll: jest.fn(),
    findByPhone: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
  };

  const prisma = {
    customer: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    customerAddress: {
      create: jest.fn(),
      createMany: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };
  const prismaClient = {
    ...prisma,
    $transaction: jest.fn((work: (tx: typeof prisma) => Promise<unknown>) =>
      work(prisma),
    ),
  };

  const tenantPrisma = {
    getClient: jest.fn().mockReturnValue(tenantClient),
    getTenantId: jest.fn().mockReturnValue('tenant-1'),
  };

  // Only delegates exercised by this unit suite are represented by the doubles.
  const service = new CustomersService(
    customerRepo,
    prismaClient as unknown as PrismaService,
    tenantPrisma as unknown as TenantPrismaService,
  );

  return {
    service,
    customerRepo,
    prisma: prismaClient,
    tenantPrisma,
    tenantClient,
  };
}

describe('CustomersService tenant-scoped reads', () => {
  it('findAll uses tenant client instead of base prisma', async () => {
    const { service, tenantPrisma, tenantClient, prisma } = makeService();
    tenantClient.customer.findMany.mockResolvedValue([]);

    await service.findAll();

    expect(tenantPrisma.getClient).toHaveBeenCalled();
    expect(tenantClient.customer.findMany).toHaveBeenCalled();
    expect(prisma.customer.findMany).not.toHaveBeenCalled();
  });

  it('findOne/buildFullResponse reads customer with tenant client', async () => {
    const { service, tenantPrisma, tenantClient, prisma } = makeService();
    tenantClient.customer.findUnique.mockResolvedValue({
      ...makeCustomerRecord('cust-1'),
      globalPriceList: null,
      addresses: [],
    });

    await service.findOne('cust-1');

    expect(tenantPrisma.getClient).toHaveBeenCalled();
    expect(tenantClient.customer.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cust-1' } }),
    );
    expect(prisma.customer.findUnique).not.toHaveBeenCalled();
  });

  it('getAddresses uses tenant client for address listing', async () => {
    const { service, customerRepo, tenantPrisma, tenantClient, prisma } =
      makeService();
    customerRepo.findById.mockResolvedValue(makeCustomerRecord('cust-1'));
    tenantClient.customerAddress.findMany.mockResolvedValue([]);

    await service.getAddresses('cust-1');

    expect(tenantPrisma.getClient).toHaveBeenCalled();
    expect(tenantClient.customerAddress.findMany).toHaveBeenCalledWith({
      where: { customerId: 'cust-1' },
      orderBy: { createdAt: 'asc' },
    });
    expect(prisma.customerAddress.findMany).not.toHaveBeenCalled();
  });

  it('address ownership checks use tenant client in update/remove', async () => {
    const { service, tenantClient, prisma } = makeService();
    tenantClient.customerAddress.findFirst.mockResolvedValue({
      id: 'addr-1',
      customerId: 'cust-1',
    });
    tenantClient.customerAddress.update.mockResolvedValue({});
    tenantClient.customerAddress.delete.mockResolvedValue({});

    await service.updateAddress('cust-1', 'addr-1', { city: 'CDMX' });
    await service.removeAddress('cust-1', 'addr-1');

    expect(tenantClient.customerAddress.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.customerAddress.findFirst).not.toHaveBeenCalled();
  });
});

describe('CustomersService address coordinates', () => {
  it('returns coordinates in customer list and detail reads', async () => {
    const { service, tenantClient } = makeService();
    const row = {
      ...makeCustomerRecord('cust-1'),
      globalPriceList: null,
      addresses: [{ id: 'addr-1', latitude: 0, longitude: 0 }],
    };
    tenantClient.customer.findMany.mockResolvedValue([row]);
    tenantClient.customer.findUnique.mockResolvedValue(row);
    expect((await service.findAll())[0].addresses).toEqual(row.addresses);
    expect((await service.findOne('cust-1')).addresses).toEqual(row.addresses);
  });

  it('creates nested coordinates atomically and returns read rows', async () => {
    const { service, prisma, tenantClient } = makeService();
    tenantClient.customer.findUnique.mockResolvedValue({
      ...makeCustomerRecord('cust-1'),
      globalPriceList: null,
      addresses: [{ id: 'addr-1', latitude: 0, longitude: 0 }],
    });
    const response = await service.create({
      firstName: 'Ada',
      addresses: [
        { street: 'Main St', latitude: 0, longitude: 0 },
        { street: 'Side St' },
      ],
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.customerAddress.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ latitude: 0, longitude: 0 }),
        expect.objectContaining({ latitude: null, longitude: null }),
      ],
    });
    expect(response.addresses).toEqual([
      { id: 'addr-1', latitude: 0, longitude: 0 },
    ]);
  });

  it('creates a standalone address with a null pair when absent and a numeric pair when present', async () => {
    const { service, customerRepo, prisma } = makeService();
    customerRepo.findById.mockResolvedValue(makeCustomerRecord('cust-1'));
    prisma.customerAddress.create.mockResolvedValue({
      latitude: 0,
      longitude: 0,
    });
    await service.addAddress('cust-1', { street: 'Main St' });
    await service.addAddress('cust-1', {
      street: 'Main St',
      latitude: 0,
      longitude: 0,
    });
    expect(prisma.customerAddress.create.mock.calls).toMatchObject([
      [{ data: { latitude: null, longitude: null } }],
      [{ data: { latitude: 0, longitude: 0 } }],
    ]);
  });

  it('preserves omitted coordinates and clears or replaces both together', async () => {
    const { service, customerRepo, tenantClient, prisma } = makeService();
    customerRepo.findById.mockResolvedValue(makeCustomerRecord('cust-1'));
    tenantClient.customerAddress.findFirst.mockResolvedValue({
      id: 'addr-1',
      customerId: 'cust-1',
    });
    prisma.customerAddress.update.mockResolvedValue({
      latitude: null,
      longitude: null,
    });
    await service.updateAddress('cust-1', 'addr-1', { city: 'CDMX' });
    await service.updateAddress('cust-1', 'addr-1', {
      latitude: null,
      longitude: null,
    });
    await service.updateAddress('cust-1', 'addr-1', {
      latitude: 0,
      longitude: 0,
    });
    expect(prisma.customerAddress.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'addr-1' },
      data: { city: 'CDMX' },
    });
    expect(prisma.customerAddress.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'addr-1' },
      data: { latitude: null, longitude: null },
    });
    expect(prisma.customerAddress.update).toHaveBeenNthCalledWith(3, {
      where: { id: 'addr-1' },
      data: { latitude: 0, longitude: 0 },
    });
    tenantClient.customerAddress.findMany.mockResolvedValue([
      { latitude: 0, longitude: 0 },
    ]);
    expect(await service.getAddresses('cust-1')).toEqual([
      { latitude: 0, longitude: 0 },
    ]);
  });
});

describe('CustomersService phone normalization', () => {
  it('stores only digits for a POS-created phone and country code', async () => {
    const { service, prisma, tenantClient } = makeService();
    tenantClient.customer.findUnique.mockResolvedValue({
      ...makeCustomerRecord('cust-1'),
      globalPriceList: null,
      addresses: [],
    });
    await service.create({
      firstName: 'Ada',
      phoneCountryCode: '+52',
      phone: '55 8587 6245',
    });
    const [{ data }] = prisma.customer.create.mock.calls[0] as [
      { data: { phoneCountryCode: string | null; phone: string | null } },
    ];
    expect(data).toMatchObject({ phoneCountryCode: '52', phone: '5585876245' });
  });

  it('stores null when a phone part has no digits on create', async () => {
    const { service, prisma, tenantClient } = makeService();
    tenantClient.customer.findUnique.mockResolvedValue({
      ...makeCustomerRecord('cust-1'),
      globalPriceList: null,
      addresses: [],
    });
    await service.create({
      firstName: 'Ada',
      phoneCountryCode: '+',
      phone: ' - ',
    });
    const [{ data }] = prisma.customer.create.mock.calls[0] as [
      { data: { phoneCountryCode: string | null; phone: string | null } },
    ];
    expect(data).toMatchObject({ phoneCountryCode: null, phone: null });
  });

  it('stores only digits on update and null when nothing remains', async () => {
    const { service, customerRepo, tenantClient } = makeService();
    const record = {
      ...makeCustomerRecord('cust-1'),
      phoneCountryCode: '52',
      phone: '5512345678',
    };
    customerRepo.findById.mockResolvedValue(
      Customer.fromPersistence({ ...record, preferredPaymentMethod: null }),
    );
    tenantClient.customer.findUnique.mockResolvedValue({
      ...record,
      globalPriceList: null,
      addresses: [],
    });
    await service.update('cust-1', {
      phoneCountryCode: ' +52 ',
      phone: '(55) 8587-6245',
    });
    expect(customerRepo.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ phoneCountryCode: '52', phone: '5585876245' }),
    );
    await service.update('cust-1', { phoneCountryCode: '+', phone: '' });
    expect(customerRepo.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ phoneCountryCode: null, phone: null }),
    );
  });

  it('keeps stored phone parts when update omits them', async () => {
    const { service, customerRepo, tenantClient } = makeService();
    const record = {
      ...makeCustomerRecord('cust-1'),
      phoneCountryCode: '52',
      phone: '5512345678',
    };
    customerRepo.findById.mockResolvedValue(
      Customer.fromPersistence({ ...record, preferredPaymentMethod: null }),
    );
    tenantClient.customer.findUnique.mockResolvedValue({
      ...record,
      globalPriceList: null,
      addresses: [],
    });
    await service.update('cust-1', { firstName: 'Eva' });
    expect(customerRepo.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ phoneCountryCode: '52', phone: '5512345678' }),
    );
  });
});
