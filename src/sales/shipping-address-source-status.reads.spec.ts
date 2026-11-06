import type { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { PrismaSaleRepository } from './infrastructure/prisma-sale.repository';
import {
  liveShippingAddressSourceSelect,
  shippingAddressColumns,
} from './infrastructure/shipping-address-snapshot.mapper';
import { SalesService } from './sales.service';

const snapshot = {
  street: 'Original Street',
  exteriorNumber: '12',
  interiorNumber: null,
  zipCode: '64000',
  neighborhood: 'Centro',
  municipality: 'Monterrey',
  city: 'Monterrey',
  state: 'Nuevo Leon',
  visualReferences: 'Blue gate',
  carrierPhone: '5512345678',
  label: 'Home',
  latitude: 25.68,
  longitude: -100.31,
};

type Kind = 'unchanged' | 'edited' | 'label' | 'deleted' | 'foreign' | 'legacy';

function liveFor(kind: Kind) {
  switch (kind) {
    case 'unchanged':
      return { tenantId: 'tenant-1', ...snapshot };
    case 'edited':
      return {
        tenantId: 'tenant-1',
        ...snapshot,
        street: 'Edited Street',
        longitude: -100.3,
      };
    case 'label':
      return { tenantId: 'tenant-1', ...snapshot, label: 'Casa' };
    case 'foreign':
      return { tenantId: 'tenant-2', ...snapshot, street: 'Foreign Ave' };
    default:
      return null;
  }
}

function fixture(kind: Kind) {
  const row = {
    id: 'sale-1',
    tenantId: 'tenant-1',
    folio: 'A-1',
    status: 'CONFIRMED',
    channel: 'POS',
    register: 'Principal',
    paymentStatus: 'PAID',
    deliveryStatus: 'PENDING',
    subtotalCents: 100,
    discountCents: 0,
    totalCents: 100,
    paidCents: 100,
    debtCents: 0,
    changeDueCents: 0,
    confirmedAt: new Date('2026-11-01T00:00:00Z'),
    dueDate: null,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    canceledByUserId: null,
    shippingAddressId:
      kind === 'deleted' || kind === 'legacy' ? null : 'address-1',
    ...shippingAddressColumns(kind === 'legacy' ? null : snapshot),
    shippingAddress: liveFor(kind),
    customer: null,
    user: { id: 'cashier-1', name: 'Cashier' },
    seller: null,
    items: [],
    payments: [],
    refunds: [],
  };
  const client = {
    sale: {
      findFirst: jest.fn().mockResolvedValue(row),
      findMany: jest.fn().mockResolvedValue([row]),
    },
  };
  const tenant = {
    getClient: () => client,
    getTenantId: () => 'tenant-1',
  } as unknown as TenantPrismaService;
  return { client, repo: new PrismaSaleRepository(tenant) };
}

const view = (overrides: Record<string, unknown>) => ({
  id: 'address-1',
  ...snapshot,
  sourceStatus: 'UNCHANGED',
  changedFields: [],
  ...overrides,
});

const EXPECTED: Record<Kind, unknown> = {
  unchanged: view({}),
  edited: view({
    sourceStatus: 'CHANGED',
    changedFields: ['street', 'longitude'],
  }),
  label: view({ sourceStatus: 'CHANGED', changedFields: ['label'] }),
  deleted: view({ id: null, sourceStatus: 'DELETED' }),
  foreign: view({ sourceStatus: 'DELETED' }),
  legacy: null,
};

const KINDS = Object.keys(EXPECTED) as Kind[];

describe('GET /sales shipping address source status', () => {
  it('loads the live source with its tenantId in the same page query', async () => {
    const { client, repo } = fixture('unchanged');
    await repo.findManyConfirmed({
      page: 1,
      limit: 20,
      sortBy: 'confirmedAt',
      sortOrder: 'desc',
    });
    expect(client.sale.findMany).toHaveBeenCalledTimes(1);
    expect(client.sale.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining(
          liveShippingAddressSourceSelect,
        ) as unknown,
      }),
    );
  });

  it.each(KINDS)('list row exposes the snapshot when %s', async (kind) => {
    const { repo } = fixture(kind);
    const [row] = await repo.findManyConfirmed({
      page: 1,
      limit: 20,
      sortBy: 'confirmedAt',
      sortOrder: 'desc',
    });
    expect(row.shippingAddress).toEqual(EXPECTED[kind]);
    expect(JSON.stringify(row)).not.toContain('Foreign Ave');
    expect(JSON.stringify(row)).not.toContain('Edited Street');
  });
});

describe('GET /sales/:id shipping address source status', () => {
  it('loads the live source with its tenantId in the detail query', async () => {
    const { client, repo } = fixture('unchanged');
    await repo.findOneWithRelations('sale-1');
    expect(client.sale.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining(
          liveShippingAddressSourceSelect,
        ) as unknown,
      }),
    );
  });

  it.each(KINDS)('detail exposes the snapshot when %s', async (kind) => {
    const { repo } = fixture(kind);
    const service = Object.create(SalesService.prototype) as SalesService;
    Object.assign(service, {
      saleRepo: repo,
      saleCommentsRepo: { findActiveBySale: jest.fn().mockResolvedValue([]) },
    });
    const detail = await service.getSaleDetail(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(detail.shippingAddress).toEqual(EXPECTED[kind]);
    expect(JSON.stringify(detail)).not.toContain('Foreign Ave');
  });

  it('defaults to null when the repository omits the address', async () => {
    const service = Object.create(SalesService.prototype) as SalesService;
    Object.assign(service, {
      saleRepo: {
        findOneWithRelations: jest.fn().mockResolvedValue({
          id: 'sale-1',
          folio: 'A-1',
          status: 'CONFIRMED',
          channel: 'POS',
          register: 'Principal',
          confirmedAt: null,
          dueDate: null,
          createdAt: new Date(),
          subtotalCents: 0,
          discountCents: 0,
          totalCents: 0,
          paidCents: 0,
          debtCents: 0,
          changeDueCents: 0,
          paymentStatus: null,
          deliveryStatus: 'DELIVERED',
          customer: null,
          cashier: { id: 'c', name: 'C' },
          seller: null,
          items: [],
          payments: [],
        }),
      },
      saleCommentsRepo: { findActiveBySale: jest.fn().mockResolvedValue([]) },
    });
    const detail = await service.getSaleDetail(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(detail.shippingAddress).toBeNull();
  });
});
