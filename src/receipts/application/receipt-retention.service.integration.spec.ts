/**
 * INTEGRATION SPEC: 5-year retention purge against the real
 * `nest-practice-test` DB (port 5433 — NEVER dev) with the in-memory fake
 * storage port (no network). Every assertion is scoped to the fixture
 * tenants, because the purge itself is deliberately cross-tenant.
 */
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import type { ReceiptStoragePort } from '../domain/receipt-storage.port';
import { ReceiptRetentionService } from './receipt-retention.service';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

class FakeStorage implements ReceiptStoragePort {
  readonly objects = new Set<string>();
  readonly removed: string[] = [];
  readonly failing = new Set<string>();

  putPrivate(input: { key: string }) {
    this.objects.add(input.key);
    return Promise.resolve();
  }

  delete(key: string) {
    this.objects.delete(key);
    return Promise.resolve();
  }

  remove(key: string) {
    if (this.failing.has(key)) return Promise.reject(new Error('denied'));
    this.removed.push(key);
    this.objects.delete(key);
    return Promise.resolve();
  }

  getPrivate() {
    return Promise.resolve({ body: Readable.from([]), contentLength: 0 });
  }
}

const NOW = new Date('2031-11-06T03:00:00.000Z');
const OLD = new Date('2026-11-05T00:00:00.000Z'); // > 5 years before NOW
const RECENT = new Date('2026-11-07T00:00:00.000Z'); // < 5 years before NOW

describeIfDb('ReceiptRetentionService (Integration)', () => {
  let prisma: PrismaClient;
  let storage: FakeStorage;
  let service: ReceiptRetentionService;
  const tenantIds = [randomUUID(), randomUUID()];
  const userId = randomUUID();
  const saleIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    for (const id of tenantIds) {
      await prisma.tenant.create({
        data: { id, name: 'Retention', slug: `ret-${id.slice(0, 8)}` },
      });
    }
    await prisma.user.create({
      data: {
        id: userId,
        email: `ret-${userId.slice(0, 8)}@example.com`,
        hashedPassword: 'x',
        name: 'Retention',
        isActive: true,
      },
    });
    for (const tenantId of tenantIds) {
      const id = randomUUID();
      saleIds.push(id);
      await prisma.sale.create({
        data: {
          id,
          tenantId,
          userId,
          status: 'CONFIRMED',
          channel: 'ONLINE',
          totalCents: 10_000,
          paidCents: 10_000,
          debtCents: 0,
          paymentStatus: 'PAID',
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.receiptEvidence.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    storage = new FakeStorage();
    service = new ReceiptRetentionService(
      prisma as unknown as PrismaService,
      storage,
    );
  });

  async function createReceipt(input: {
    tenant: 0 | 1;
    createdAt: Date;
    pdf?: boolean;
    legacy?: boolean;
    foreignKey?: boolean;
  }) {
    const tenantId = tenantIds[input.tenant];
    const saleId = saleIds[input.tenant];
    const owner = input.foreignKey ? tenantIds[1 - input.tenant] : tenantId;
    const base = `receipts/${owner}/${saleId}/${randomUUID()}`;
    const storageKey = input.legacy
      ? null
      : `${base}.${input.pdf ? 'pdf' : 'png'}`;
    const previewKey = input.legacy
      ? null
      : input.pdf
        ? `${base}.preview.png`
        : storageKey;
    for (const key of [storageKey, previewKey]) {
      if (key) storage.objects.add(key);
    }
    return prisma.receiptEvidence.create({
      data: {
        id: randomUUID(),
        saleId,
        tenantId,
        mediaUrl: input.legacy ? 'https://legacy.example/r.jpg' : null,
        storageKey,
        mimeType: input.legacy
          ? null
          : input.pdf
            ? 'application/pdf'
            : 'image/png',
        previewKey,
        previewMimeType: previewKey ? 'image/png' : null,
        previewStatus: input.legacy ? null : 'READY',
        declaredAmountCents: 10_000,
        status: 'CONFIRMED',
        createdAt: input.createdAt,
      },
    });
  }

  function fixtureRows() {
    return prisma.receiptEvidence.findMany({
      where: { tenantId: { in: tenantIds } },
    });
  }

  it('dry run reports candidates and changes nothing', async () => {
    await createReceipt({ tenant: 0, createdAt: OLD, pdf: true });
    await createReceipt({ tenant: 1, createdAt: OLD });
    const before = await fixtureRows();

    const result = await service.purgeBatch({ now: NOW, dryRun: true });

    expect(result.scanned).toBeGreaterThanOrEqual(2);
    expect(result.purged).toBe(0);
    expect(storage.removed).toEqual([]);
    expect(await fixtureRows()).toEqual(before);
  });

  it('deletes original + preview of receipts older than 5 years in every tenant and keeps the accounting row', async () => {
    const pdf = await createReceipt({ tenant: 0, createdAt: OLD, pdf: true });
    const png = await createReceipt({ tenant: 1, createdAt: OLD });
    const recent = await createReceipt({ tenant: 0, createdAt: RECENT });
    const legacy = await createReceipt({
      tenant: 1,
      createdAt: OLD,
      legacy: true,
    });

    await service.purgeBatch({ now: NOW });

    expect(storage.removed).toEqual(
      expect.arrayContaining([
        pdf.storageKey,
        pdf.previewKey,
        png.storageKey,
      ]) as unknown as string[],
    );
    // An image is its own preview: removed once.
    expect(
      storage.removed.filter((key) => key === png.storageKey),
    ).toHaveLength(1);
    expect(storage.objects.has(recent.storageKey as string)).toBe(true);

    const rows = new Map((await fixtureRows()).map((row) => [row.id, row]));
    for (const id of [pdf.id, png.id]) {
      expect(rows.get(id)).toMatchObject({
        purgedAt: NOW,
        storageKey: null,
        previewKey: null,
        declaredAmountCents: 10_000,
        status: 'CONFIRMED',
      });
    }
    expect(rows.get(recent.id)).toMatchObject({ purgedAt: null });
    expect(rows.get(legacy.id)).toMatchObject({
      purgedAt: null,
      mediaUrl: 'https://legacy.example/r.jpg',
    });
  });

  it('is idempotent: a second run purges nothing more', async () => {
    await createReceipt({ tenant: 0, createdAt: OLD, pdf: true });
    await service.purgeBatch({ now: NOW });
    const removedAfterFirst = storage.removed.length;

    await service.purgeBatch({ now: NOW });

    expect(storage.removed).toHaveLength(removedAfterFirst);
  });

  it('keeps the keys when a delete fails so the next run retries', async () => {
    const receipt = await createReceipt({
      tenant: 0,
      createdAt: OLD,
      pdf: true,
    });
    storage.failing.add(receipt.previewKey as string);

    const result = await service.purgeBatch({ now: NOW });

    expect(result.failed).toBeGreaterThanOrEqual(1);
    const row = await prisma.receiptEvidence.findUniqueOrThrow({
      where: { id: receipt.id },
    });
    expect(row).toMatchObject({
      purgedAt: null,
      storageKey: receipt.storageKey,
      previewKey: receipt.previewKey,
    });
  });

  it('never deletes a key outside the receipt tenant prefix', async () => {
    const receipt = await createReceipt({
      tenant: 0,
      createdAt: OLD,
      foreignKey: true,
    });

    const result = await service.purgeBatch({ now: NOW });

    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(storage.removed).not.toContain(receipt.storageKey);
    const row = await prisma.receiptEvidence.findUniqueOrThrow({
      where: { id: receipt.id },
    });
    expect(row.purgedAt).toBeNull();
  });

  it('does not let a full batch of permanently failing rows starve newer due rows', async () => {
    const failingA = await createReceipt({
      tenant: 0,
      createdAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    const failingB = await createReceipt({
      tenant: 1,
      createdAt: new Date('2020-01-02T00:00:00.000Z'),
      foreignKey: true,
    });
    const due = await createReceipt({ tenant: 0, createdAt: OLD, pdf: true });
    storage.failing.add(failingA.storageKey as string);

    // Same run (same `now`): failed rows are not scanned again.
    const first = await service.purgeBatch({ now: NOW, batchSize: 2 });
    const second = await service.purgeBatch({ now: NOW, batchSize: 2 });

    expect(first).toMatchObject({ scanned: 2, purged: 0, failed: 2 });
    expect(second.purged).toBeGreaterThanOrEqual(1);
    const rows = new Map((await fixtureRows()).map((row) => [row.id, row]));
    expect(rows.get(due.id)?.purgedAt).toEqual(NOW);
    for (const id of [failingA.id, failingB.id]) {
      expect(rows.get(id)).toMatchObject({
        purgedAt: null,
        purgeAttempts: 1,
        lastPurgeErrorAt: NOW,
      });
    }

    // Next day: rows that keep failing go after the ones never tried.
    const fresh = await createReceipt({ tenant: 1, createdAt: OLD });
    const tomorrow = new Date(NOW.getTime() + 24 * 3600 * 1000);
    await service.purgeBatch({ now: tomorrow, batchSize: 1 });

    const after = await prisma.receiptEvidence.findUniqueOrThrow({
      where: { id: fresh.id },
    });
    expect(after.purgedAt).toEqual(tomorrow);
  });

  it('retries a previously failing row on a later run and purges it once it succeeds', async () => {
    const receipt = await createReceipt({ tenant: 0, createdAt: OLD });
    storage.failing.add(receipt.storageKey as string);
    await service.purgeBatch({ now: NOW });
    storage.failing.clear();

    const tomorrow = new Date(NOW.getTime() + 24 * 3600 * 1000);
    await service.purgeBatch({ now: tomorrow });

    const row = await prisma.receiptEvidence.findUniqueOrThrow({
      where: { id: receipt.id },
    });
    expect(row).toMatchObject({ purgedAt: tomorrow, storageKey: null });
  });

  it('honours the batch size', async () => {
    for (let i = 0; i < 3; i += 1) {
      await createReceipt({ tenant: 0, createdAt: OLD });
    }

    const result = await service.purgeBatch({ now: NOW, batchSize: 2 });

    expect(result.scanned).toBe(2);
  });
});
