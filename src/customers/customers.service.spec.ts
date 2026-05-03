import { CustomersService } from './customers.service';
import { CUSTOMER_REPOSITORY } from './domain/customer.repository';

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
    save: jest.fn(),
    delete: jest.fn(),
  };

  const prisma = {
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

  const tenantPrisma = {
    getClient: jest.fn().mockReturnValue(tenantClient),
    getTenantId: jest.fn().mockReturnValue('tenant-1'),
  };

  const service = new CustomersService(
    customerRepo,
    prisma,
    tenantPrisma,
  );

  return { service, customerRepo, prisma, tenantPrisma, tenantClient };
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
