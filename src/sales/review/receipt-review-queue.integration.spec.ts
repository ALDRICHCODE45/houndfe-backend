/**
 * INTEGRATION SPEC: review queue reads (per sale and tenant-wide) and the
 * rejection write against the real `nest-practice-test` DB (port 5433 —
 * NEVER dev). The repository and service run on real Prisma rows; payment
 * collaborators are unused stubs.
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { OutboxWriterService } from '../../shared/outbox/outbox-writer.service';
import type { SalesService } from '../sales.service';
import type { ISaleRepository } from '../domain/sale.repository';
import { PrismaReceiptReviewRepository } from './infrastructure/prisma-receipt-review.repository';
import { ReceiptReviewService } from './receipt-review.service';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

describeIfDb('Receipt review queue (Integration)', () => {
  let prisma: PrismaClient;
  let service: ReceiptReviewService;
  let currentTenantId = '';
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const userId = randomUUID();
  let saleId: string;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    const cls = {
      get: (key: string) => {
        if (key === 'tenantId') return currentTenantId;
        if (key === 'isSuperAdmin') return false;
        return undefined;
      },
    } as unknown as ClsService<TenantClsStore>;
    const tenantPrisma = new TenantPrismaService(
      prisma as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
      cls,
    );
    const saleRepository = {
      runInTransaction: <T>(work: () => Promise<T>) =>
        tenantPrisma.runInTransaction(work),
    } as unknown as ISaleRepository;
    service = new ReceiptReviewService(
      new PrismaReceiptReviewRepository(tenantPrisma),
      {} as SalesService,
      saleRepository,
      tenantPrisma,
      new OutboxWriterService(),
    );

    for (const id of [tenantId, otherTenantId]) {
      await prisma.tenant.create({
        data: { id, name: 'Receipt queue', slug: `rq-${id.slice(0, 8)}` },
      });
    }
    await prisma.user.create({
      data: {
        id: userId,
        email: `rq-${userId.slice(0, 8)}@example.com`,
        hashedPassword: 'x',
        name: 'Receipt queue',
        isActive: true,
      },
    });
    const customer = await prisma.customer.create({
      data: { tenantId, firstName: 'Ana', lastName: 'López' },
    });
    saleId = await createSale(tenantId, customer.id, 'V-0042');
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({
      where: { id: { in: [tenantId, otherTenantId] } },
    });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  beforeEach(() => {
    currentTenantId = tenantId;
  });

  async function createSale(
    tenant: string,
    customerId: string | null,
    folio: string | null,
  ): Promise<string> {
    const id = randomUUID();
    await prisma.sale.create({
      data: {
        id,
        tenantId: tenant,
        userId,
        customerId,
        folio,
        status: 'CONFIRMED',
        channel: 'ONLINE',
        totalCents: 10_000,
        paidCents: 0,
        debtCents: 10_000,
        paymentStatus: 'CREDIT',
      },
    });
    return id;
  }

  async function createPrivateReceipt(
    sale: string,
    tenant: string,
    createdAt: Date,
  ): Promise<string> {
    const id = randomUUID();
    await prisma.receiptEvidence.create({
      data: {
        id,
        saleId: sale,
        tenantId: tenant,
        storageKey: `receipts/${tenant}/${sale}/${randomUUID()}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: 2048,
        sha256: 'a'.repeat(64),
        previewKey: `receipts/${tenant}/${sale}/${randomUUID()}.preview.png`,
        previewMimeType: 'image/png',
        previewStatus: 'READY',
        extracted: { amountCents: 10_000, bank: 'BBVA', confidence: 0.9 },
        mismatch: { debtCents: 10_000, extractedDiffCents: 0, flagged: false },
        status: 'PENDING',
        createdAt,
      },
    });
    return id;
  }

  it('returns the v1 keys plus the additive file/extracted/mismatch keys from real rows', async () => {
    const receiptId = await createPrivateReceipt(
      saleId,
      tenantId,
      new Date('2026-11-05T09:00:00.000Z'),
    );

    const items = await service.listPending(saleId);
    const item = items.find((candidate) => candidate.id === receiptId);

    expect(item).toEqual({
      id: receiptId,
      saleId,
      mediaUrl: '',
      declaredAmountCents: 0,
      declaredDate: null,
      declaredReference: null,
      status: 'PENDING',
      salePaymentStatus: 'CREDIT',
      salePaidCents: 0,
      saleDebtCents: 10_000,
      saleTotalCents: 10_000,
      declaredAmountProvided: false,
      file: {
        mimeType: 'application/pdf',
        sizeBytes: 2048,
        previewStatus: 'READY',
        originalUrl: `/sales/${saleId}/receipts/${receiptId}/file`,
        previewUrl: `/sales/${saleId}/receipts/${receiptId}/preview`,
      },
      extracted: { amountCents: 10_000, bank: 'BBVA', confidence: 0.9 },
      mismatch: { debtCents: 10_000, extractedDiffCents: 0, flagged: false },
      createdAt: new Date('2026-11-05T09:00:00.000Z'),
    });
  });

  it('pages the tenant-wide queue oldest first and never shows another tenant', async () => {
    const otherSale = await createSale(otherTenantId, null, 'X-1');
    await createPrivateReceipt(
      otherSale,
      otherTenantId,
      new Date('2020-01-01T00:00:00.000Z'),
    );
    const secondSale = await createSale(tenantId, null, null);
    const a = await createPrivateReceipt(
      secondSale,
      tenantId,
      new Date('2026-11-05T10:00:00.000Z'),
    );
    const b = await createPrivateReceipt(
      saleId,
      tenantId,
      new Date('2026-11-05T11:00:00.000Z'),
    );

    const first = await service.listPendingForTenant({ limit: 2 });
    const rest = await service.listPendingForTenant({
      limit: 2,
      cursor: first.nextCursor as string,
    });
    const all = [...first.items, ...rest.items];

    expect(first.nextCursor).not.toBeNull();
    expect(rest.nextCursor).toBeNull();
    expect(all.every((item) => item.saleId !== otherSale)).toBe(true);
    const ids = all.map((item) => item.id);
    expect(ids.indexOf(a)).toBeLessThan(ids.indexOf(b));
    expect(all.find((item) => item.id === b)).toMatchObject({
      saleFolio: 'V-0042',
      customerName: 'Ana López',
    });
    expect(all.find((item) => item.id === a)).toMatchObject({
      saleFolio: null,
      customerName: null,
    });
  });
});
