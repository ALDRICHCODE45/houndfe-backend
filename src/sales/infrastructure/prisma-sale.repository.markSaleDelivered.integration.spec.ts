/**
 * INTEGRATION SPEC: PrismaSaleRepository.markSaleDelivered — delivery-routes / WU3 (task 3.18).
 *
 * Proves the ADR-3 Sale mirror flip against the real `nest-practice-test`
 * database (port 5433 — NEVER the dev DB):
 *
 *   1. Own tenant → the sale's `deliveryStatus` flips `PENDING → DELIVERED`
 *      and the method resolves `void`.
 *   2. Cross-tenant → the explicit `where: { id, tenantId }` guard in the
 *      adapter raises `P2025` (record not found) and the foreign sale is
 *      NOT modified. The caller (`DeliveryRoutesService.checkInStop`) maps
 *      that P2025 to `DeliveryRouteNotFoundError` (404 semantics).
 *
 * Mirrors the `prisma-quotation.repository.integration.spec.ts` /
 * `prisma-promotion.repository.integration.spec.ts` setup: shared Prisma
 * client + CLS shim + `resetAndSeedBaseline()` in `afterEach` so a mid-test
 * failure cannot leak rows into the next spec.
 *
 * Skips gracefully when the test DB is unreachable (`SKIP_DB_INTEGRATION=1`
 * or unset `DATABASE_URL`).
 */
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
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

describeIfDb('PrismaSaleRepository.markSaleDelivered (Integration - Real DB)', () => {
  let prisma: PrismaClient;
  let repo: PrismaSaleRepository;
  let tenantId: string;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();

    // Wipe state from any previous run, then re-seed the baseline tenant
    // (globalSetup already applied migrations + seeded it at suite boot).
    await resetAndSeedBaseline();

    const tenant = await prisma.tenant.findFirst({ select: { id: true } });
    if (!tenant) {
      throw new Error(
        'No tenant found for integration test. globalSetup must have seeded one — ' +
          'verify .env.test and that `pnpm run test:db:up` has the container running.',
      );
    }
    tenantId = tenant.id;
    expect(tenantId).toBe(BASELINE_TENANT_ID);

    const cls: Pick<ClsService<TenantClsStore>, 'get'> = {
      get: (key: string) => {
        if (key === 'tenantId') return tenantId;
        if (key === 'isSuperAdmin') return false;
        return undefined;
      },
    };
    const tenantPrisma = new TenantPrismaService(
      prisma as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
      cls as ClsService<TenantClsStore>,
    );
    repo = new PrismaSaleRepository(tenantPrisma);
  });

  afterEach(async () => {
    // Robust cascade reset — wipes sales/users/tenants and re-seeds the
    // baseline tenant so the next test starts from a clean slate.
    await resetAndSeedBaseline();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await disconnectIntegrationPrisma();
  });

  /** Seed a cashier user + a PENDING sale for the given tenant. */
  async function seedPendingSale(targetTenantId: string): Promise<{ saleId: string }> {
    const userId = randomUUID();
    await prisma.user.create({
      data: {
        id: userId,
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
        userId,
        tenantId: targetTenantId,
        status: 'CONFIRMED',
        channel: 'ONLINE',
        deliveryStatus: 'PENDING',
        folio: `A-${randomUUID().slice(0, 8)}`,
      },
    });
    return { saleId };
  }

  describe('own-tenant mirror flip', () => {
    it('resolves void and flips the sale deliveryStatus PENDING → DELIVERED inside the supplied tx', async () => {
      const { saleId } = await seedPendingSale(tenantId);

      // The adapter receives the raw Prisma transaction client (same shape
      // `DeliveryRoutesService.checkInStop` passes via repo.runInTransaction).
      await prisma.$transaction(async (tx) => {
        await expect(repo.markSaleDelivered(tx, { tenantId, saleId })).resolves.toBeUndefined();
      });

      const after = await prisma.sale.findUnique({ where: { id: saleId } });
      expect(after?.deliveryStatus).toBe('DELIVERED');
    });

    it('is idempotent when the sale is already DELIVERED', async () => {
      const { saleId } = await seedPendingSale(tenantId);
      await prisma.sale.update({
        where: { id: saleId },
        data: { deliveryStatus: 'DELIVERED' },
      });

      await prisma.$transaction(async (tx) => {
        await expect(repo.markSaleDelivered(tx, { tenantId, saleId })).resolves.toBeUndefined();
      });

      const after = await prisma.sale.findUnique({ where: { id: saleId } });
      expect(after?.deliveryStatus).toBe('DELIVERED');
    });
  });

  describe('cross-tenant isolation', () => {
    it('raises P2025 for a sale that belongs to another tenant and does NOT modify it', async () => {
      // Second tenant with its own cashier + PENDING sale.
      const foreignTenantId = randomUUID();
      await prisma.tenant.create({
        data: { id: foreignTenantId, name: 'Foreign Tenant', slug: `foreign-${randomUUID()}`, isActive: true },
      });
      const { saleId } = await seedPendingSale(foreignTenantId);

      // Call with the CURRENT (baseline) tenant — the sale id belongs to
      // the foreign tenant, so `where: { id, tenantId }` matches nothing
      // and Prisma raises P2025. The caller (DeliveryRoutesService) maps
      // this to DeliveryRouteNotFoundError → 404.
      const error = await prisma
        .$transaction(async (tx) => {
          await repo.markSaleDelivered(tx, { tenantId, saleId });
        })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2025');

      // Foreign sale untouched.
      const after = await prisma.sale.findUnique({ where: { id: saleId } });
      expect(after?.deliveryStatus).toBe('PENDING');
    });

    it('raises P2025 for a missing sale id (no-op semantics for the caller)', async () => {
      const error = await prisma
        .$transaction(async (tx) => {
          await repo.markSaleDelivered(tx, {
            tenantId,
            saleId: randomUUID(),
          });
        })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2025');
    });
  });
});
