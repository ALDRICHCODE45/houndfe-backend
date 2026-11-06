/**
 * INTEGRATION SPEC: PrismaEligibleSalesReader — shipping address source status.
 *
 * Proves against the real test database (port 5433 — NEVER the dev DB) that
 * the nested live-address select drives `sourceStatus` without rewriting the
 * sale snapshot: UNCHANGED, CHANGED after an in-place edit, DELETED after a
 * hard delete (FK SET NULL), and DELETED for a foreign-tenant live row.
 *
 * Skips when the test DB is unreachable (`SKIP_DB_INTEGRATION=1` or unset
 * `DATABASE_URL`).
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import {
  BASELINE_TENANT_ID,
  disconnectIntegrationPrisma,
  resetAndSeedBaseline,
} from '../../../test/integration/reset-db';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { SHIPPING_ADDRESS_SNAPSHOT_KEYS } from '../../sales/domain/shipping-address-source-status';
import { PrismaEligibleSalesReader } from './eligible-sales-prisma.reader';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

const ADDRESS = {
  street: 'Av. Reforma',
  exteriorNumber: '123',
  interiorNumber: null,
  zipCode: '06600',
  neighborhood: 'Juárez',
  municipality: 'Cuauhtémoc',
  city: 'CDMX',
  state: 'CDMX',
  visualReferences: 'Portón azul',
  carrierPhone: '5512345678',
  label: 'Oficina',
  latitude: 19.43,
  longitude: -99.13,
};

describeIfDb(
  'PrismaEligibleSalesReader source status (Integration - Real DB)',
  () => {
    let prisma: PrismaClient;
    let reader: PrismaEligibleSalesReader;
    const tenantId = BASELINE_TENANT_ID;

    beforeAll(async () => {
      prisma = new PrismaClient();
      await prisma.$connect();
      await resetAndSeedBaseline();
      const cls = {
        get: (key?: string): unknown => {
          if (key === undefined) return { tenantId, isSuperAdmin: false };
          if (key === 'tenantId') return tenantId;
          if (key === 'isSuperAdmin') return false;
          return undefined;
        },
        set: (): void => undefined,
      } as unknown as ClsService<TenantClsStore>;
      const tenantPrisma = new TenantPrismaService(
        prisma as unknown as ConstructorParameters<
          typeof TenantPrismaService
        >[0],
        cls,
      );
      reader = new PrismaEligibleSalesReader(tenantPrisma);
    });

    afterEach(async () => {
      await resetAndSeedBaseline();
    });

    afterAll(async () => {
      await prisma.$disconnect();
      await disconnectIntegrationPrisma();
    });

    /** Seed a customer address in `addressTenantId` and a baseline-tenant sale snapshotting it. */
    async function seedSale(addressTenantId: string = tenantId) {
      const customerId = randomUUID();
      await prisma.customer.create({
        data: { id: customerId, firstName: 'María', tenantId: addressTenantId },
      });
      const addressId = randomUUID();
      await prisma.customerAddress.create({
        data: {
          id: addressId,
          customerId,
          tenantId: addressTenantId,
          ...ADDRESS,
        },
      });
      const cashierId = randomUUID();
      await prisma.user.create({
        data: {
          id: cashierId,
          email: `cashier-${randomUUID()}@test.local`,
          hashedPassword: 'test',
          name: 'Cashier',
          isActive: true,
        },
      });
      const saleId = randomUUID();
      await prisma.sale.create({
        data: {
          id: saleId,
          userId: cashierId,
          tenantId,
          shippingAddressId: addressId,
          shippingStreet: ADDRESS.street,
          shippingExteriorNumber: ADDRESS.exteriorNumber,
          shippingInteriorNumber: ADDRESS.interiorNumber,
          shippingZipCode: ADDRESS.zipCode,
          shippingNeighborhood: ADDRESS.neighborhood,
          shippingMunicipality: ADDRESS.municipality,
          shippingCity: ADDRESS.city,
          shippingState: ADDRESS.state,
          shippingVisualReferences: ADDRESS.visualReferences,
          shippingCarrierPhone: ADDRESS.carrierPhone,
          shippingLabel: ADDRESS.label,
          shippingLatitude: ADDRESS.latitude,
          shippingLongitude: ADDRESS.longitude,
          status: 'CONFIRMED',
          channel: 'ONLINE',
          deliveryStatus: 'PENDING',
          folio: `F-${randomUUID().slice(0, 8)}`,
        },
      });
      return { addressId };
    }

    async function readAddress() {
      const page = await reader.findEligibleSales({
        tenantId,
        page: 1,
        limit: 20,
        saleScope: null,
      });
      expect(page.rows).toHaveLength(1);
      return page.rows[0].shippingAddress;
    }

    it('reports UNCHANGED, then CHANGED after an edit, then DELETED after a hard delete, never rewriting the snapshot', async () => {
      const { addressId } = await seedSale();

      const unchanged = await readAddress();
      expect(unchanged).toEqual({
        id: addressId,
        ...ADDRESS,
        sourceStatus: 'UNCHANGED',
        changedFields: [],
      });
      expect(Object.keys(unchanged ?? {}).sort()).toEqual(
        [
          'id',
          ...SHIPPING_ADDRESS_SNAPSHOT_KEYS,
          'sourceStatus',
          'changedFields',
        ].sort(),
      );

      await prisma.customerAddress.update({
        where: { id: addressId },
        data: { street: 'Av. Insurgentes', label: 'Casa' },
      });
      expect(await readAddress()).toEqual({
        id: addressId,
        ...ADDRESS,
        sourceStatus: 'CHANGED',
        changedFields: ['street', 'label'],
      });

      await prisma.customerAddress.delete({ where: { id: addressId } });
      expect(await readAddress()).toEqual({
        id: null,
        ...ADDRESS,
        sourceStatus: 'DELETED',
        changedFields: [],
      });
    });

    it('treats a live source row owned by another tenant as DELETED without exposing it', async () => {
      const foreignTenantId = randomUUID();
      await prisma.tenant.create({
        data: {
          id: foreignTenantId,
          name: 'Foreign Tenant',
          slug: `foreign-${randomUUID()}`,
          isActive: true,
        },
      });
      const { addressId } = await seedSale(foreignTenantId);
      await prisma.customerAddress.update({
        where: { id: addressId },
        data: { street: 'Foreign Ave' },
      });

      const address = await readAddress();
      expect(address).toEqual({
        id: addressId,
        ...ADDRESS,
        sourceStatus: 'DELETED',
        changedFields: [],
      });
      expect(JSON.stringify(address)).not.toContain('Foreign Ave');
    });
  },
);
