import { SalesService } from './sales.service';
import { Sale } from './domain/sale.entity';
import { PrismaSaleRepository } from './infrastructure/prisma-sale.repository';
import type { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';

const snapshot = {
  street: 'First Street',
  exteriorNumber: '12',
  interiorNumber: 'B',
  zipCode: '64000',
  neighborhood: 'Centro',
  municipality: 'Monterrey',
  city: 'Monterrey',
  state: 'Nuevo León',
  visualReferences: 'Blue gate',
  carrierPhone: '5512345678',
  label: 'Home',
  latitude: 25.68,
  longitude: -100.31,
};
const address = {
  id: 'address-1',
  tenantId: 'tenant-1',
  customerId: 'customer-1',
  ...snapshot,
};
const columns = Object.fromEntries(
  Object.entries(snapshot).map(([key, value]) => [
    `shipping${key[0].toUpperCase()}${key.slice(1)}`,
    value,
  ]),
);

// The fixture installs only ports exercised by the actual application methods.
function fixture() {
  const sale = Sale.create({ id: 'sale-1', userId: 'cashier-1' });
  const live = { ...address };
  const findAddress = jest
    .fn()
    .mockImplementation(() => Promise.resolve({ ...live }));
  const client = {
    product: {
      findUnique: jest.fn().mockResolvedValue({ hasVariants: false }),
    },
    customer: { findUnique: jest.fn().mockResolvedValue({ id: 'customer-1' }) },
    customerAddress: { findUnique: findAddress },
  };
  const repo = {
    findById: jest.fn().mockResolvedValue(sale),
    findByIdForUpdate: jest.fn().mockResolvedValue(sale),
    findDraftResponseById: jest.fn(),
    save: jest.fn().mockResolvedValue(sale),
    runInTransaction: jest.fn(async (work: () => Promise<unknown>) => work()),
    acquireChargeIdempotency: jest
      .fn()
      .mockResolvedValue({ kind: 'acquired', token: 'key' }),
    allocateNextFolio: jest.fn().mockResolvedValue('A-202610-1'),
    persistChargeConfirmation: jest.fn().mockResolvedValue([]),
    markChargeIdempotencySucceeded: jest.fn(),
  };
  const service = Object.create(SalesService.prototype) as SalesService;
  Object.assign(service, {
    saleRepo: repo,
    tenantPrisma: { getTenantId: () => 'tenant-1', getClient: () => client },
    eventEmitter: { emit: jest.fn() },
    recomputePricingAndPromotions: jest.fn().mockResolvedValue({
      promotionCapacityDemands: [],
      capacityExcludedPromotionIds: [],
    }),
    productsService: {
      getApplicablePrices: jest.fn().mockResolvedValue([{ priceCents: 1000 }]),
      decrementStockForCharge: jest.fn(),
    },
    promotionUsageRepo: { claimForSale: jest.fn() },
    outboxWriter: { publish: jest.fn() },
  });
  return { service, repo, sale, live, findAddress };
}

const assignment = {
  customerId: address.customerId,
  shippingAddressId: address.id,
};

describe('sale shipping address snapshot writes', () => {
  it.each(['assign', 'change'] as const)(
    'copies all delivery fields on POS %s',
    async (path) => {
      const { service, repo, sale, live, findAddress } = fixture();
      if (path === 'assign') {
        await service.assignCustomer(sale.id, sale.userId, assignment);
      } else {
        sale.assignCustomer(address.customerId);
        await service.setShippingAddress(sale.id, sale.userId, {
          shippingAddressId: address.id,
        });
      }
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ shippingAddressSnapshot: snapshot }),
      );
      expect(findAddress).toHaveBeenCalledWith({
        where: { id: address.id, tenantId: address.tenantId },
      });
      live.street = 'Later edit';
      expect(sale).toHaveProperty('shippingAddressSnapshot', snapshot);
      expect(sale.toResponse()).not.toHaveProperty('shippingAddressSnapshot');
    },
  );

  it.each(['address', 'null body', 'customer', 'reassign'] as const)(
    'clears the snapshot on POS clear %s',
    async (path) => {
      const { service, sale, repo } = fixture();
      await service.assignCustomer(sale.id, sale.userId, assignment);
      if (path === 'address')
        await service.clearShippingAddress(sale.id, sale.userId);
      if (path === 'null body')
        await service.setShippingAddress(sale.id, sale.userId, {
          shippingAddressId: null,
        });
      if (path === 'customer')
        await service.clearCustomer(sale.id, sale.userId);
      if (path === 'reassign')
        await service.assignCustomer(sale.id, sale.userId, {
          customerId: 'customer-2',
        });
      expect(repo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          shippingAddressId: null,
          shippingAddressSnapshot: null,
        }),
      );
    },
  );

  it.each(['address', 'null body', 'customer'] as const)(
    'clears a draft snapshot on POS clear %s after the address was deleted',
    async (path) => {
      const { service, sale: draft, repo } = fixture();
      await service.assignCustomer(draft.id, draft.userId, assignment);
      // Deleting the customer address nulls the FK and keeps the snapshot.
      Object.assign(draft, {
        _shippingAddressId: null,
        ...(path === 'customer' ? { _customerId: null } : {}),
      });
      expect(draft.shippingAddressSnapshot).toEqual(snapshot);
      if (path === 'address')
        await service.clearShippingAddress(draft.id, draft.userId);
      else if (path === 'customer')
        await service.clearCustomer(draft.id, draft.userId);
      else
        await service.setShippingAddress(draft.id, draft.userId, {
          shippingAddressId: null,
        });
      expect(repo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          shippingAddressId: null,
          shippingAddressSnapshot: null,
        }),
      );
    },
  );

  it('refreshes the live address inside POS DRAFT confirmation', async () => {
    const { service, sale, live, repo } = fixture();
    await service.assignCustomer(sale.id, sale.userId, assignment);
    live.street = 'Edited before charge';
    await service.chargeDraft(sale.id, sale.userId, { payments: [] }, 'key');
    expect(repo.persistChargeConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        shippingAddressSnapshot: { ...snapshot, street: live.street },
      }),
    );
  });

  it('copies the tenant-scoped address for bot confirmation', async () => {
    const { service, repo } = fixture();
    await service.confirmBotSale({
      ...assignment,
      cashierUserId: 'cashier-1',
      items: [
        {
          productId: 'product-1',
          productName: 'Product',
          quantity: 1,
          unitPriceCents: 1000,
        },
      ],
    });
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ shippingAddressSnapshot: snapshot }),
    );
    expect(repo.persistChargeConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ shippingAddressSnapshot: snapshot }),
    );
  });

  it.each(['missing', 'foreign customer'] as const)(
    'rejects a %s address at POS confirmation without persisting',
    async (kind) => {
      const { service, sale, repo, findAddress } = fixture();
      sale.assignCustomer(address.customerId, address.id);
      findAddress.mockResolvedValue(
        kind === 'missing'
          ? null
          : { ...address, customerId: 'another-customer' },
      );
      await expect(
        service.chargeDraft(sale.id, sale.userId, { payments: [] }, 'key'),
      ).rejects.toMatchObject({
        code:
          kind === 'missing'
            ? 'SHIPPING_ADDRESS_NOT_FOUND'
            : 'SHIPPING_ADDRESS_NOT_FOR_CUSTOMER',
      });
      expect(repo.persistChargeConfirmation).not.toHaveBeenCalled();
    },
  );

  it('preserves copied values across confirm/cancel and rejects post-confirm replacement', async () => {
    const { service, sale } = fixture();
    await service.assignCustomer(sale.id, sale.userId, assignment);
    sale.markForDelivery();
    const confirmed = sale.confirm({ confirmedAt: new Date(), folio: 'A-1' });
    expect(confirmed.shippingAddressSnapshot).toEqual(snapshot);
    const exposed = confirmed.shippingAddressSnapshot!;
    exposed.street = 'Mutation attempt';
    expect(confirmed.shippingAddressSnapshot).toEqual(snapshot);
    expect(() => confirmed.captureShippingAddress(null)).toThrow(
      'SALE_NOT_DRAFT',
    );
    expect(
      confirmed.cancel('CUSTOMER_REQUEST', { actorId: sale.userId }).sale
        .shippingAddressSnapshot,
    ).toEqual(snapshot);
  });

  it('guards snapshot confirmation writes against an already confirmed row', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const repo = new PrismaSaleRepository({
      getTenantId: () => 'tenant-1',
      getClient: () => ({ sale: { updateMany } }),
    } as unknown as TenantPrismaService);
    await expect(
      repo.persistChargeConfirmation({
        saleId: 'sale-1',
        userId: 'cashier-1',
        shippingAddressSnapshot: snapshot,
        payments: [],
        subtotalCents: 0,
        discountCents: 0,
        totalCents: 0,
        paidCents: 0,
        debtCents: 0,
        changeDueCents: 0,
        paymentStatus: 'PAID',
        confirmedAt: new Date(),
        folio: 'A-1',
      }),
    ).rejects.toMatchObject({ code: 'SALE_NOT_DRAFT' });
    const write = (
      updateMany.mock.calls as unknown as [{ where: unknown; data: unknown }][]
    )[0][0];
    expect(write.where).toEqual({
      id: 'sale-1',
      tenantId: 'tenant-1',
      status: 'DRAFT',
    });
    expect(write.data).toMatchObject(columns);
  });

  it('hydrates snapshot columns even when deletion has nulled the address FK', async () => {
    const row = {
      id: 'sale-1',
      userId: 'cashier-1',
      status: 'CONFIRMED',
      shippingAddressId: null,
      ...columns,
      items: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const repo = new PrismaSaleRepository({
      getTenantId: () => 'tenant-1',
      getClient: () => ({
        sale: { findUnique: jest.fn().mockResolvedValue(row) },
      }),
    } as unknown as TenantPrismaService);
    expect(await repo.findById(row.id)).toHaveProperty(
      'shippingAddressSnapshot',
      snapshot,
    );
  });
});
