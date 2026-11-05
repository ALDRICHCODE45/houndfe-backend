/**
 * INTEGRATION SPEC: PrismaSaleRepository GET /sales/:id for canceled sales.
 *
 * The sales list returns CANCELED rows and the FE links each one to the
 * detail screen, but `findOneWithRelations` used to filter on
 * `status: 'CONFIRMED'`, so a canceled sale answered 404. This spec pins,
 * against the real `nest-practice-test` database (port 5433 — NEVER the dev
 * DB), that the detail reads CONFIRMED and CANCELED sales with their stored
 * cancellation facts and refund obligations, while DRAFT sales and other
 * tenants' sales stay invisible.
 *
 * Mirrors the `prisma-sale.repository.list-total.integration.spec.ts` setup.
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  BASELINE_TENANT_ID,
  disconnectIntegrationPrisma,
  resetAndSeedBaseline,
} from '../../../test/integration/reset-db';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { ClsService } from 'nestjs-cls';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { PrismaSaleRepository } from './prisma-sale.repository';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

describeIfDb(
  'PrismaSaleRepository canceled sale detail (Integration - Real DB)',
  () => {
    let prisma: PrismaClient;
    let repo: PrismaSaleRepository;
    let tenantId: string;

    beforeAll(async () => {
      prisma = new PrismaClient();
      await prisma.$connect();
      await resetAndSeedBaseline();

      const tenant = await prisma.tenant.findFirst({ select: { id: true } });
      if (!tenant) {
        throw new Error('No tenant found for integration test.');
      }
      tenantId = tenant.id;
      expect(tenantId).toBe(BASELINE_TENANT_ID);

      const clsStore = new Map<string, unknown>([
        ['tenantId', tenantId],
        ['isSuperAdmin', false],
      ]);
      const cls = {
        get: (key: string) => clsStore.get(key),
        set: (key: string, value: unknown) => {
          clsStore.set(key, value);
        },
      } as unknown as ClsService<TenantClsStore>;
      const tenantPrisma = new TenantPrismaService(
        prisma as unknown as ConstructorParameters<
          typeof TenantPrismaService
        >[0],
        cls,
      );
      repo = new PrismaSaleRepository(tenantPrisma);
    });

    afterEach(async () => {
      await resetAndSeedBaseline();
    });

    afterAll(async () => {
      await prisma.$disconnect();
      await disconnectIntegrationPrisma();
    });

    async function seedUser(name: string): Promise<string> {
      const userId = randomUUID();
      await prisma.user.create({
        data: {
          id: userId,
          email: `user-${randomUUID()}@test.local`,
          hashedPassword: 'test',
          name,
          isActive: true,
        },
      });
      return userId;
    }

    async function seedSale(input: {
      tenantId: string;
      userId: string;
      status: 'DRAFT' | 'CONFIRMED' | 'CANCELED';
      canceledByUserId?: string;
    }): Promise<string> {
      const id = randomUUID();
      const canceled = input.status === 'CANCELED';
      await prisma.sale.create({
        data: {
          id,
          tenantId: input.tenantId,
          userId: input.userId,
          status: input.status,
          channel: 'POS',
          folio: input.status === 'DRAFT' ? null : `V-${id.slice(0, 6)}`,
          totalCents: 3000,
          subtotalCents: 3000,
          paidCents: input.status === 'DRAFT' ? 0 : 3000,
          paymentStatus: input.status === 'DRAFT' ? null : 'PAID',
          deliveryStatus: 'PENDING',
          confirmedAt:
            input.status === 'DRAFT'
              ? null
              : new Date('2026-05-08T11:00:00.000Z'),
          canceledAt: canceled ? new Date('2026-05-09T09:00:00.000Z') : null,
          cancelReason: canceled ? 'CUSTOMER_REQUEST' : null,
          canceledByUserId: canceled ? (input.canceledByUserId ?? null) : null,
        },
      });
      return id;
    }

    async function seedForeignTenant(): Promise<string> {
      const foreignTenantId = randomUUID();
      await prisma.tenant.create({
        data: {
          id: foreignTenantId,
          name: 'Foreign Tenant',
          slug: `foreign-${randomUUID()}`,
          isActive: true,
        },
      });
      return foreignTenantId;
    }

    it('reads a canceled sale with its cancellation facts and refund obligations', async () => {
      const cashierId = await seedUser('Cashier');
      const managerId = await seedUser('Manager');
      const saleId = await seedSale({
        tenantId,
        userId: cashierId,
        status: 'CANCELED',
        canceledByUserId: managerId,
      });
      await prisma.saleRefund.create({
        data: {
          id: `refund-${randomUUID()}`,
          tenantId,
          saleId,
          method: 'CASH',
          amountCents: 3000,
          settledCents: 1000,
          reason: 'CUSTOMER_REQUEST',
          status: 'PENDING',
          createdAt: new Date('2026-05-09T09:00:00.000Z'),
        },
      });

      const detail = await repo.findOneWithRelations(saleId);

      expect(detail).toMatchObject({
        id: saleId,
        status: 'CANCELED',
        canceledAt: new Date('2026-05-09T09:00:00.000Z'),
        cancelReason: 'CUSTOMER_REQUEST',
        canceledBy: { id: managerId, name: 'Manager' },
        refunds: [
          {
            method: 'cash',
            amountCents: 3000,
            settledCents: 1000,
            outstandingCents: 2000,
            reason: 'CUSTOMER_REQUEST',
            status: 'PENDING',
          },
        ],
      });
    });

    it('reads a confirmed sale with empty cancellation facts', async () => {
      const cashierId = await seedUser('Cashier');
      const saleId = await seedSale({
        tenantId,
        userId: cashierId,
        status: 'CONFIRMED',
      });

      const detail = await repo.findOneWithRelations(saleId);

      expect(detail).toMatchObject({
        status: 'CONFIRMED',
        canceledAt: null,
        cancelReason: null,
        canceledBy: null,
        refunds: [],
      });
    });

    it('keeps draft sales out of the detail read', async () => {
      const cashierId = await seedUser('Cashier');
      const saleId = await seedSale({
        tenantId,
        userId: cashierId,
        status: 'DRAFT',
      });

      await expect(repo.findOneWithRelations(saleId)).resolves.toBeNull();
    });

    it("never reads another tenant's canceled sale", async () => {
      const cashierId = await seedUser('Cashier');
      const foreignTenantId = await seedForeignTenant();
      const saleId = await seedSale({
        tenantId: foreignTenantId,
        userId: cashierId,
        status: 'CANCELED',
      });

      await expect(repo.findOneWithRelations(saleId)).resolves.toBeNull();
    });
  },
);
