import type { Prisma } from '@prisma/client';
import type { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { PrismaSaleRepository } from './infrastructure/prisma-sale.repository';
import { shippingAddressColumns } from './infrastructure/shipping-address-snapshot.mapper';
import { ChatbotApiService } from '../chatbot-api/application/chatbot-api.service';
import { PrismaDeliveryRouteRepository } from '../delivery-routes/infrastructure/prisma-delivery-route.repository';
import { PrismaEligibleSalesReader } from '../delivery-routes/infrastructure/eligible-sales-prisma.reader';
import { DeliveryRoutesService } from '../delivery-routes/application/delivery-routes.service';
import { DeliveryRoute } from '../delivery-routes/domain/delivery-route.entity';

const snapshot = {
  street: 'Original Street',
  exteriorNumber: '12',
  interiorNumber: 'B',
  zipCode: '64000',
  neighborhood: 'Centro',
  municipality: 'Monterrey',
  city: 'Monterrey',
  state: 'Nuevo Leon',
  label: 'Home',
  visualReferences: 'Blue gate',
  carrierPhone: '5512345678',
  latitude: 25.68,
  longitude: -100.31,
};

function fixture(kind: 'edited' | 'deleted' | 'legacy') {
  const row = {
    id: 'sale-1',
    userId: 'cashier-1',
    tenantId: 'tenant-1',
    folio: 'A-1',
    status: 'CONFIRMED',
    channel: 'ONLINE',
    deliveryStatus: 'PENDING',
    shippingAddressId: kind === 'deleted' ? null : 'address-1',
    ...shippingAddressColumns(kind === 'legacy' ? null : snapshot),
    shippingAddress:
      kind === 'deleted'
        ? null
        : {
            id: 'address-1',
            tenantId: 'tenant-1',
            ...snapshot,
            street: 'Edited Street',
            zipCode: '99999',
            latitude: 0,
            longitude: 0,
          },
    customer: null,
    items: [],
    payments: [],
    deliveryRouteStops: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    confirmedAt: new Date(),
  };
  const route = {
    id: 'route-1',
    tenantId: 'tenant-1',
    stops: [{ id: 'stop-1', saleId: row.id, sale: row }],
  };
  const client = {
    sale: {
      findUnique: jest.fn().mockResolvedValue(row),
      findFirst: jest.fn().mockResolvedValue(row),
      findMany: jest
        .fn<Promise<(typeof row)[]>, [unknown]>()
        .mockResolvedValue([row]),
      count: jest.fn().mockResolvedValue(1),
    },
    deliveryRoute: {
      findFirst: jest.fn().mockResolvedValue(route),
      findMany: jest.fn().mockResolvedValue([route]),
    },
  };
  const tenant = {
    getClient: () => client,
    getTenantId: () => 'tenant-1',
  } as unknown as TenantPrismaService;
  const routes = Object.create(
    DeliveryRoutesService.prototype,
  ) as DeliveryRoutesService;
  Object.assign(routes, { tenantPrisma: tenant });
  return { row, client, tenant, routes };
}

// Exercise production read methods with independently editable live relations.
describe('sale shipping snapshot reads', () => {
  it.each(['edited', 'deleted', 'legacy'] as const)(
    'POS address is snapshot-only after %s',
    async (kind) => {
      const { tenant } = fixture(kind);
      const result = await new PrismaSaleRepository(
        tenant,
      ).findDraftResponseById('sale-1');
      expect(result?.shippingAddress).toEqual(
        kind === 'legacy'
          ? null
          : {
              id: kind === 'deleted' ? null : 'address-1',
              street: snapshot.street,
              exteriorNumber: snapshot.exteriorNumber,
              interiorNumber: snapshot.interiorNumber,
              zipCode: snapshot.zipCode,
              neighborhood: snapshot.neighborhood,
              municipality: snapshot.municipality,
              city: snapshot.city,
              state: snapshot.state,
            },
      );
    },
  );

  it.each(['edited', 'deleted', 'legacy'] as const)(
    'bot history is snapshot-only after %s',
    async (kind) => {
      const { tenant } = fixture(kind);
      const bot = Object.create(
        ChatbotApiService.prototype,
      ) as ChatbotApiService;
      Object.assign(bot, {
        tenantPrisma: tenant,
        customerRepository: {
          findByPhone: jest.fn().mockResolvedValue({ id: 'customer-1' }),
        },
      });
      const result = await bot.getOrderHistoryByPhone({
        phoneCountryCode: '52',
        phone: '5512345678',
      });
      expect(result[0].shippingAddress).toEqual(
        kind === 'legacy'
          ? null
          : { street: snapshot.street, zipCode: snapshot.zipCode },
      );
    },
  );

  describe.each(['detail', 'list'] as const)('route %s', (method) => {
    it.each(['edited', 'deleted', 'legacy'] as const)(
      'keeps the snapshot and coordinates after %s',
      async (kind) => {
        const { tenant } = fixture(kind);
        const repo = new PrismaDeliveryRouteRepository(tenant);
        const result =
          method === 'detail'
            ? await repo.findOneWithStops({
                tenantId: 'tenant-1',
                id: 'route-1',
              })
            : (await repo.list({ tenantId: 'tenant-1' }))[0];
        if (kind === 'legacy')
          expect(result?.stops[0].shippingAddress).toBeNull();
        else
          expect(result?.stops[0].shippingAddress).toMatchObject({
            id: kind === 'deleted' ? null : 'address-1',
            street: snapshot.street,
            zipCode: snapshot.zipCode,
            latitude: snapshot.latitude,
            longitude: snapshot.longitude,
          });
      },
    );
  });

  it.each(['edited', 'deleted', 'legacy'] as const)(
    'eligible-sales address is snapshot-only after %s',
    async (kind) => {
      const { tenant } = fixture(kind);
      const result = await new PrismaEligibleSalesReader(
        tenant,
      ).findEligibleSales({
        tenantId: 'tenant-1',
        page: 1,
        limit: 10,
        saleScope: null,
      });
      if (kind === 'legacy') expect(result.rows[0].shippingAddress).toBeNull();
      else
        expect(result.rows[0].shippingAddress).toMatchObject({
          id: kind === 'deleted' ? null : 'address-1',
          street: snapshot.street,
          zipCode: snapshot.zipCode,
        });
    },
  );

  it.each(['64000', 'Original Street'])(
    'searches snapshot columns for %s, never the relation',
    async (q) => {
      const { tenant, client } = fixture('edited');
      await new PrismaEligibleSalesReader(tenant).findEligibleSales({
        tenantId: 'tenant-1',
        page: 1,
        limit: 10,
        saleScope: null,
        q,
      });
      const args = client.sale.findMany.mock.calls[0][0] as {
        where: { AND: { OR?: Record<string, unknown>[] }[] };
      };
      const branches = args.where.AND.find((clause) => clause.OR)?.OR;
      expect(branches).toContainEqual({
        shippingStreet: { contains: q, mode: 'insensitive' },
      });
      expect(branches).toContainEqual({
        shippingZipCode: { contains: q, mode: 'insensitive' },
      });
      expect(JSON.stringify(args.where)).not.toContain('shippingAddress');
      expect(client.sale.count).toHaveBeenCalledWith({ where: args.where });
    },
  );

  it.each(['edited', 'deleted', 'legacy'] as const)(
    'next-stop notification is snapshot-only after %s',
    async (kind) => {
      const { routes, client } = fixture(kind);
      const payload = await routes['composeNextStopPayload'](
        client as unknown as Prisma.TransactionClient,
        'tenant-1',
        { id: 'route-1' } as DeliveryRoute,
        'stop-1',
        'stop-2',
        'sale-1',
      );
      if (kind === 'legacy') expect(payload.nextAddressLabel).toBeNull();
      else {
        expect(payload.nextAddressLabel).toContain(snapshot.street);
        expect(payload.nextAddressLabel).toContain(snapshot.zipCode);
        expect(payload.nextAddressLabel).not.toContain('Edited Street');
      }
    },
  );

  it.each(['deleted', 'legacy'] as const)(
    'route eligibility uses the snapshot after %s',
    async (kind) => {
      const { routes } = fixture(kind);
      const creation = DeliveryRoute.create({
        id: 'route-1',
        tenantId: 'tenant-1',
        driverUserId: 'driver-1',
        saleIds: ['sale-1'],
        checkSaleEligibility: (id) =>
          routes['checkSaleEligibility'](id, 'tenant-1'),
      });
      if (kind === 'legacy')
        await expect(creation).rejects.toMatchObject({
          details: { reason: 'INELIGIBLE_SALE' },
        });
      else await expect(creation).resolves.toBeDefined();
    },
  );
});
