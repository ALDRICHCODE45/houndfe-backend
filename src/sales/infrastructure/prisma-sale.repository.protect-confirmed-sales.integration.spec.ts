import { PrismaClient } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import { PrismaSaleRepository } from './prisma-sale.repository';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import {
  BASELINE_TENANT_ID,
  disconnectIntegrationPrisma,
  resetAndSeedBaseline,
} from '../../../test/integration/reset-db';

const unavailable =
  !process.env.DATABASE_URL || process.env.SKIP_DB_INTEGRATION === '1';
const describeIfPostgres = unavailable ? describe.skip : describe;
const POLL_DEADLINE_MS = 5000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const createProduct = async (prisma: PrismaClient) => {
  const userId = randomUUID();
  const productId = randomUUID();
  await prisma.user.create({
    data: {
      id: userId,
      email: `${randomUUID()}@atomic.test`,
      hashedPassword: 'test',
      name: 'Atomic user',
    },
  });
  await prisma.product.create({
    data: {
      id: productId,
      name: 'Test Product',
      tenantId: BASELINE_TENANT_ID,
      type: 'PRODUCT',
    },
  });
  return { userId, productId };
};

const makeItem = (
  saleId: string,
  productId: string,
  overrides: Partial<{
    id: string;
    quantity: number;
    unitPriceCents: number;
  }> = {},
) => ({
  id: overrides.id ?? randomUUID(),
  saleId,
  tenantId: BASELINE_TENANT_ID,
  productId,
  quantity: overrides.quantity ?? 1,
  unitPriceCents: overrides.unitPriceCents ?? 500,
  unitPriceCurrency: 'MXN',
  productName: 'Test Product',
  variantId: null,
  variantName: null,
  imageUrl: null,
  originalPriceCents: null,
  priceSource: 'DEFAULT' as const,
  appliedPriceListId: null,
  customPriceCents: null,
  discountType: null,
  discountValue: null,
  discountAmountCents: null,
  rewardDiscountPercent: null,
  rewardKind: null,
  prePriceCentsBeforeDiscount: null,
  discountTitle: null,
  discountedAt: null,
  promotionId: null,
});

describeIfPostgres('sales repository atomic parent lock (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let repository: PrismaSaleRepository;
  let tenantPrisma: TenantPrismaService;
  let saleId: string;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    await resetAndSeedBaseline();

    const clsStore = new Map<string, unknown>([
      ['tenantId', BASELINE_TENANT_ID],
    ]);
    const cls = {
      get: (key: string) => clsStore.get(key),
      set: (key: string, value: unknown) => {
        clsStore.set(key, value);
      },
    } as unknown as ClsService<TenantClsStore>;
    tenantPrisma = new TenantPrismaService(
      prisma as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
      cls,
    );
    repository = new PrismaSaleRepository(tenantPrisma);
  });

  beforeEach(async () => {
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `${randomUUID()}@atomic.test`,
        hashedPassword: 'test',
        name: 'Atomic test user',
      },
    });
    saleId = randomUUID();
    await prisma.sale.create({
      data: {
        id: saleId,
        userId: user.id,
        tenantId: BASELINE_TENANT_ID,
        status: 'CONFIRMED',
        channel: 'ONLINE',
      },
    });
  });

  afterEach(async () => {
    await resetAndSeedBaseline();
  });

  afterAll(async () => {
    await resetAndSeedBaseline();
    await prisma?.$disconnect();
    await disconnectIntegrationPrisma();
  });

  const waitForDeleteLock = async () => {
    const deadline = Date.now() + POLL_DEADLINE_MS;
    while (Date.now() < deadline) {
      const waiting = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity waiter
          WHERE waiter.wait_event_type = 'Lock'
            AND waiter.query ILIKE '%FOR UPDATE%'
            AND waiter.query ILIKE '%sales%'
            AND cardinality(pg_blocking_pids(waiter.pid)) > 0
        ) AS blocked
      `;
      if (waiting[0]?.blocked) return true;
      await sleep(25);
    }
    return false;
  };

  const createDraftSale = async (
    itemOverrides: Array<
      Partial<{ id: string; quantity: number; unitPriceCents: number }>
    > = [{}],
  ) => {
    const { userId, productId } = await createProduct(prisma);
    const draftSaleId = randomUUID();
    await prisma.sale.create({
      data: {
        id: draftSaleId,
        userId,
        tenantId: BASELINE_TENANT_ID,
        status: 'DRAFT',
        channel: 'ONLINE',
      },
    });
    await prisma.saleItem.createMany({
      data: itemOverrides.map((item) => makeItem(draftSaleId, productId, item)),
    });
    return draftSaleId;
  };

  it('waits on the parent lock, then rereads committed state through save', async () => {
    const staleSale = (await repository.findById(saleId))!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "sales"
        WHERE "id" = ${saleId} AND "tenantId" = ${BASELINE_TENANT_ID}
        FOR UPDATE
      `;
      await tx.sale.update({
        where: { id: saleId },
        data: { status: 'CANCELED' },
      });
      await held;
    });

    let blocked = false;
    const second = repository.save(staleSale);
    try {
      const deadline = Date.now() + POLL_DEADLINE_MS;
      while (Date.now() < deadline) {
        const waiting = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity waiter
            WHERE waiter.wait_event_type = 'Lock'
              AND waiter.query ILIKE '%FOR UPDATE%'
              AND cardinality(pg_blocking_pids(waiter.pid)) > 0
          ) AS blocked
        `;
        if (waiting[0]?.blocked) {
          blocked = true;
          break;
        }
        await sleep(25);
      }
      expect(blocked).toBe(true);
    } finally {
      release();
    }
    await first;
    await expect(second).resolves.toMatchObject({ status: 'CONFIRMED' });
  });

  it('rolls back repository writes in an ambient transaction and cleans up', async () => {
    const sale = (await repository.findById(saleId))!;

    await expect(
      tenantPrisma.runInTransaction(async () => {
        await repository.save(sale);
        await tenantPrisma.getClient().sale.update({
          where: { id: saleId },
          data: { folio: 'rolled-back' },
        });
        throw new Error('rollback evidence');
      }),
    ).rejects.toThrow('rollback evidence');

    const persisted = await prisma.sale.findUnique({
      where: { id: saleId },
      select: { folio: true },
    });
    expect(persisted?.folio).toBeNull();
  });

  it('delete waits for the tenant-qualified parent lock before proceeding', async () => {
    const draftSaleId = await createDraftSale([
      { quantity: 2, unitPriceCents: 500 },
    ]);
    let lockReady!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => (lockReady = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "sales" WHERE "id" = ${draftSaleId} AND "tenantId" = ${BASELINE_TENANT_ID} FOR UPDATE`;
      lockReady();
      await held;
    });
    await locked;

    const deletion = repository.delete(draftSaleId);
    try {
      expect(await waitForDeleteLock()).toBe(true);
    } finally {
      release();
    }
    await first;
    await expect(deletion).resolves.toBeUndefined();
  });

  it('rejects a post-lock transition to CONFIRMED and preserves parent and items', async () => {
    const draftSaleId = await createDraftSale([{ unitPriceCents: 1000 }]);
    let lockReady!: () => void;
    let allowTransition!: () => void;
    let statusChanged!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => (lockReady = resolve));
    const transitionAllowed = new Promise<void>(
      (resolve) => (allowTransition = resolve),
    );
    const changed = new Promise<void>((resolve) => (statusChanged = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "sales" WHERE "id" = ${draftSaleId} AND "tenantId" = ${BASELINE_TENANT_ID} FOR UPDATE`;
      lockReady();
      await transitionAllowed;
      await tx.sale.update({
        where: { id: draftSaleId },
        data: { status: 'CONFIRMED' },
      });
      statusChanged();
      await held;
    });
    await locked;

    const deletion = repository.delete(draftSaleId);
    try {
      expect(await waitForDeleteLock()).toBe(true);
      allowTransition();
      await changed;
    } finally {
      release();
    }
    await first;
    await expect(deletion).rejects.toEqual(
      new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT'),
    );

    const parent = await prisma.sale.findUnique({
      where: { id: draftSaleId },
      select: { status: true },
    });
    expect(parent?.status).toBe('CONFIRMED');
    expect(
      await prisma.saleItem.findMany({ where: { saleId: draftSaleId } }),
    ).toHaveLength(1);
  });

  it('deletes an eligible DRAFT and cascades persisted items', async () => {
    const draftSaleId = await createDraftSale([
      { quantity: 1, unitPriceCents: 300 },
      { quantity: 2, unitPriceCents: 400 },
    ]);

    await repository.delete(draftSaleId);

    expect(
      await prisma.sale.findUnique({ where: { id: draftSaleId } }),
    ).toBeNull();
    expect(
      await prisma.saleItem.findMany({ where: { saleId: draftSaleId } }),
    ).toHaveLength(0);
  });

  it('rolls back delete effects when an outer transaction fails', async () => {
    const draftSaleId = await createDraftSale([{ unitPriceCents: 750 }]);

    await expect(
      tenantPrisma.runInTransaction(async () => {
        await repository.delete(draftSaleId);
        throw new Error('outer rollback');
      }),
    ).rejects.toThrow('outer rollback');

    expect(
      await prisma.sale.findUnique({
        where: { id: draftSaleId },
        select: { status: true },
      }),
    ).toMatchObject({ status: 'DRAFT' });
    expect(
      await prisma.saleItem.findMany({ where: { saleId: draftSaleId } }),
    ).toHaveLength(1);
  });
});
