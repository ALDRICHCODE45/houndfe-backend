import { Customer } from '../domain/customer.entity';
import { PrismaCustomerRepository } from './prisma-customer.repository';

function makeTenantPrismaMock() {
  const client = {
    customer: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
  } as any;

  return {
    getClient: jest.fn().mockReturnValue(client),
    client,
  };
}

describe('PrismaCustomerRepository tenant scoping', () => {
  it('uses TenantPrismaService client for reads', async () => {
    const tenantPrisma = makeTenantPrismaMock();
    tenantPrisma.client.customer.findUnique.mockResolvedValue(null);

    const repo = new PrismaCustomerRepository(tenantPrisma as any);
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

    const repo = new PrismaCustomerRepository(tenantPrisma as any);
    await repo.save(customer);

    expect(tenantPrisma.client.customer.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.not.objectContaining({ tenantId: expect.anything() }),
      }),
    );
  });
});
