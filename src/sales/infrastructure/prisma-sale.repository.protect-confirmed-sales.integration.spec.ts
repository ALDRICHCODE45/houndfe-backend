import { PrismaClient } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import { PrismaSaleRepository } from './prisma-sale.repository';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
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

  afterAll(async () => {
    await resetAndSeedBaseline();
    await prisma?.$disconnect();
    await disconnectIntegrationPrisma();
  });

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
});
