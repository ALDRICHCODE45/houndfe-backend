/**
 * INTEGRATION SPEC: receipt upload against the real `nest-practice-test` DB
 * (port 5433 — NEVER dev). Storage and the PDF rasterizer are in-memory fakes
 * (no network). Fixture: one randomized tenant + user per run; deleting the
 * tenant cascades its sales and receipts.
 */
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import type {
  ReceiptPreviewRasterizer,
  ReceiptStoragePort,
} from '../domain/receipt-storage.port';
import { ReceiptUploadError } from '../domain/receipt-upload.errors';
import { ReceiptUploadService } from './receipt-upload.service';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02,
]);
const PDF_BYTES = Buffer.from('%PDF-1.4\nfake receipt', 'latin1');

class FakeStorage implements ReceiptStoragePort {
  readonly objects = new Map<string, { bytes: Buffer; mimeType: string }>();
  readonly deleted: string[] = [];
  failNext = false;

  putPrivate(input: { key: string; bytes: Buffer; mimeType: string }) {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('spaces down'));
    }
    this.objects.set(input.key, {
      bytes: input.bytes,
      mimeType: input.mimeType,
    });
    return Promise.resolve();
  }

  delete(key: string) {
    this.deleted.push(key);
    this.objects.delete(key);
    return Promise.resolve();
  }
}

class FakeRasterizer implements ReceiptPreviewRasterizer {
  fail = false;
  calls = 0;

  rasterizeFirstPage() {
    this.calls += 1;
    if (this.fail) return Promise.reject(new Error('corrupt pdf'));
    return Promise.resolve({
      bytes: Buffer.from('png-preview'),
      mimeType: 'image/png' as const,
    });
  }
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ReceiptUploadError) return error.code;
    throw error;
  }
  throw new Error('expected rejection');
}

describeIfDb('ReceiptUploadService (Integration)', () => {
  let prisma: PrismaClient;
  let storage: FakeStorage;
  let rasterizer: FakeRasterizer;
  let service: ReceiptUploadService;
  let tenantId: string;
  let otherTenantId: string;
  let userId: string;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    tenantId = randomUUID();
    otherTenantId = randomUUID();
    userId = randomUUID();
    const cls = {
      get: (key: string) => {
        if (key === 'tenantId') return tenantId;
        if (key === 'isSuperAdmin') return false;
        return undefined;
      },
    } as unknown as ClsService<TenantClsStore>;
    const tenantPrisma = new TenantPrismaService(
      prisma as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
      cls,
    );
    storage = new FakeStorage();
    rasterizer = new FakeRasterizer();
    service = new ReceiptUploadService(tenantPrisma, storage, rasterizer);
    for (const id of [tenantId, otherTenantId]) {
      await prisma.tenant.create({
        data: {
          id,
          name: 'Receipts fixture',
          slug: `receipts-${id.slice(0, 8)}`,
        },
      });
    }
    await prisma.user.create({
      data: {
        id: userId,
        email: `receipts-${userId.slice(0, 8)}@example.com`,
        hashedPassword: 'x',
        name: 'Receipts fixture',
        isActive: true,
      },
    });
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({
      where: { id: { in: [tenantId, otherTenantId] } },
    });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  beforeEach(() => {
    rasterizer.fail = false;
    rasterizer.calls = 0;
  });

  async function createSale(
    overrides: Partial<{
      tenantId: string;
      status: 'DRAFT' | 'CONFIRMED' | 'CANCELED';
      paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT';
      debtCents: number;
    }> = {},
  ): Promise<string> {
    const id = randomUUID();
    const debtCents = overrides.debtCents ?? 10_000;
    await prisma.sale.create({
      data: {
        id,
        tenantId: overrides.tenantId ?? tenantId,
        userId,
        status: overrides.status ?? 'CONFIRMED',
        channel: 'ONLINE',
        totalCents: 10_000,
        paidCents: 10_000 - debtCents,
        debtCents,
        paymentStatus: overrides.paymentStatus ?? 'CREDIT',
      },
    });
    return id;
  }

  it('stores a PNG privately with metadata, image preview and mismatch', async () => {
    const saleId = await createSale();

    const response = await service.upload({
      saleId,
      idempotencyKey: `wamid-${randomUUID()}`,
      file: PNG_BYTES,
      fields: {
        declaredAmountCents: '4000',
        extracted: '{"amountCents":10000,"bank":"BBVA","confidence":0.8}',
      },
    });

    expect(response).toEqual({
      receiptId: expect.any(String) as string,
      status: 'PENDING',
      mimeType: 'image/png',
      sizeBytes: PNG_BYTES.length,
      sha256: createHash('sha256').update(PNG_BYTES).digest('hex'),
      previewStatus: 'READY',
    });
    const row = await prisma.receiptEvidence.findUniqueOrThrow({
      where: { id: response.receiptId },
    });
    expect(row.storageKey).toMatch(
      new RegExp(`^receipts/${tenantId}/${saleId}/[0-9a-f-]{36}\\.png$`),
    );
    expect(row.storageKey).not.toContain(response.receiptId);
    expect(row.previewKey).toBe(row.storageKey);
    expect(row.previewMimeType).toBe('image/png');
    expect(row.mediaUrl).toBeNull();
    expect(row.declaredAmountCents).toBe(4000);
    expect(row.extracted).toEqual({
      amountCents: 10000,
      bank: 'BBVA',
      confidence: 0.8,
    });
    expect(row.mismatch).toEqual({
      debtCents: 10_000,
      declaredDiffCents: -6000,
      extractedDiffCents: 0,
      flagged: true,
    });
    expect(storage.objects.get(row.storageKey!)?.mimeType).toBe('image/png');
    expect(rasterizer.calls).toBe(0);
  });

  it('stores a PDF with a rasterized preview next to the original', async () => {
    const saleId = await createSale();

    const response = await service.upload({
      saleId,
      idempotencyKey: `wamid-${randomUUID()}`,
      file: PDF_BYTES,
      fields: {},
    });

    const row = await prisma.receiptEvidence.findUniqueOrThrow({
      where: { id: response.receiptId },
    });
    expect(row.mimeType).toBe('application/pdf');
    expect(row.declaredAmountCents).toBeNull();
    expect(row.previewStatus).toBe('READY');
    expect(row.previewKey).toBe(
      row.storageKey!.replace(/\.pdf$/, '.preview.png'),
    );
    expect(storage.objects.get(row.previewKey!)?.mimeType).toBe('image/png');
    expect(row.mismatch).toEqual({ debtCents: 10_000, flagged: false });
  });

  it('keeps the original when the PDF preview fails', async () => {
    const saleId = await createSale();
    rasterizer.fail = true;

    const response = await service.upload({
      saleId,
      idempotencyKey: `wamid-${randomUUID()}`,
      file: PDF_BYTES,
      fields: {},
    });

    expect(response.previewStatus).toBe('UNAVAILABLE');
    const row = await prisma.receiptEvidence.findUniqueOrThrow({
      where: { id: response.receiptId },
    });
    expect(row.previewKey).toBeNull();
    expect(storage.objects.has(row.storageKey!)).toBe(true);
  });

  it('replays the same key and bytes without re-uploading', async () => {
    const saleId = await createSale();
    const key = `wamid-${randomUUID()}`;
    const first = await service.upload({
      saleId,
      idempotencyKey: key,
      file: PDF_BYTES,
      fields: {},
    });
    const objectsBefore = storage.objects.size;

    const replay = await service.upload({
      saleId,
      idempotencyKey: key,
      file: PDF_BYTES,
      fields: {},
    });

    expect(replay).toEqual(first);
    expect(storage.objects.size).toBe(objectsBefore);
    expect(rasterizer.calls).toBe(1);
    expect(await prisma.receiptEvidence.count({ where: { saleId } })).toBe(1);
  });

  it('replays even after the sale became paid', async () => {
    const saleId = await createSale();
    const key = `wamid-${randomUUID()}`;
    const first = await service.upload({
      saleId,
      idempotencyKey: key,
      file: PNG_BYTES,
      fields: {},
    });
    await prisma.sale.update({
      where: { id: saleId },
      data: { paymentStatus: 'PAID', paidCents: 10_000, debtCents: 0 },
    });

    await expect(
      service.upload({
        saleId,
        idempotencyKey: key,
        file: PNG_BYTES,
        fields: {},
      }),
    ).resolves.toEqual(first);
  });

  it('rejects the same key with different bytes as IDEMPOTENCY_KEY_REUSED', async () => {
    const saleId = await createSale();
    const key = `wamid-${randomUUID()}`;
    await service.upload({
      saleId,
      idempotencyKey: key,
      file: PNG_BYTES,
      fields: {},
    });

    expect(
      await rejection(
        service.upload({
          saleId,
          idempotencyKey: key,
          file: PDF_BYTES,
          fields: {},
        }),
      ),
    ).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('scopes the key per sale and allows several receipts per sale', async () => {
    const saleA = await createSale();
    const saleB = await createSale();
    const key = `wamid-${randomUUID()}`;

    await service.upload({
      saleId: saleA,
      idempotencyKey: key,
      file: PNG_BYTES,
      fields: {},
    });
    await service.upload({
      saleId: saleB,
      idempotencyKey: key,
      file: PNG_BYTES,
      fields: {},
    });
    await service.upload({
      saleId: saleA,
      idempotencyKey: `wamid-${randomUUID()}`,
      file: PDF_BYTES,
      fields: {},
    });

    expect(
      await prisma.receiptEvidence.count({ where: { saleId: saleA } }),
    ).toBe(2);
    expect(
      await prisma.receiptEvidence.count({ where: { saleId: saleB } }),
    ).toBe(1);
  });

  it('settles concurrent uploads of one key into a single receipt', async () => {
    const saleId = await createSale();
    const key = `wamid-${randomUUID()}`;
    const input = { saleId, idempotencyKey: key, file: PNG_BYTES, fields: {} };

    const [a, b] = await Promise.all([
      service.upload(input),
      service.upload(input),
    ]);

    expect(a).toEqual(b);
    expect(await prisma.receiptEvidence.count({ where: { saleId } })).toBe(1);
  });

  it.each([
    ['another tenant', { tenantId: 'other' }, 'SALE_NOT_FOUND'],
    [
      'a paid sale',
      { paymentStatus: 'PAID', debtCents: 0 },
      'SALE_ALREADY_PAID',
    ],
    ['a canceled sale', { status: 'CANCELED' }, 'SALE_NOT_PAYABLE'],
    ['a draft sale', { status: 'DRAFT' }, 'SALE_NOT_PAYABLE'],
  ] as const)('rejects %s before storing', async (_label, overrides, code) => {
    const saleId = await createSale({
      ...overrides,
      tenantId: 'tenantId' in overrides ? otherTenantId : tenantId,
    } as Parameters<typeof createSale>[0]);
    const objectsBefore = storage.objects.size;

    expect(
      await rejection(
        service.upload({
          saleId,
          idempotencyKey: `wamid-${randomUUID()}`,
          file: PNG_BYTES,
          fields: {},
        }),
      ),
    ).toBe(code);
    expect(storage.objects.size).toBe(objectsBefore);
    expect(await prisma.receiptEvidence.count({ where: { saleId } })).toBe(0);
  });

  it('rejects a missing sale with SALE_NOT_FOUND', async () => {
    expect(
      await rejection(
        service.upload({
          saleId: randomUUID(),
          idempotencyKey: 'k',
          file: PNG_BYTES,
          fields: {},
        }),
      ),
    ).toBe('SALE_NOT_FOUND');
  });

  it('maps a storage failure to RECEIPT_STORAGE_FAILED without a row', async () => {
    const saleId = await createSale();
    storage.failNext = true;

    expect(
      await rejection(
        service.upload({
          saleId,
          idempotencyKey: `wamid-${randomUUID()}`,
          file: PNG_BYTES,
          fields: {},
        }),
      ),
    ).toBe('RECEIPT_STORAGE_FAILED');
    expect(await prisma.receiptEvidence.count({ where: { saleId } })).toBe(0);
  });

  it('keeps legacy mediaUrl attachments working with the same sale checks', async () => {
    const saleId = await createSale();
    const legacy = await service.attachLegacyUrl({
      saleId,
      mediaUrl: 'https://example.com/receipt.jpg',
      declaredAmountCents: 10_000,
      declaredDate: null,
      declaredReference: 'REF-1',
    });
    expect(legacy).toEqual({
      receiptId: expect.any(String) as string,
      status: 'PENDING',
    });
    const row = await prisma.receiptEvidence.findUniqueOrThrow({
      where: { id: legacy.receiptId },
    });
    expect(row.mediaUrl).toBe('https://example.com/receipt.jpg');
    expect(row.storageKey).toBeNull();
    expect(row.mismatch).toEqual({
      debtCents: 10_000,
      declaredDiffCents: 0,
      flagged: false,
    });

    const paidSale = await createSale({ paymentStatus: 'PAID', debtCents: 0 });
    expect(
      await rejection(
        service.attachLegacyUrl({
          saleId: paidSale,
          mediaUrl: 'https://example.com/r.jpg',
          declaredAmountCents: null,
          declaredDate: null,
          declaredReference: null,
        }),
      ),
    ).toBe('SALE_ALREADY_PAID');
  });

  it('enforces that every receipt has a URL or a storage key', async () => {
    const saleId = await createSale();
    await expect(
      prisma.receiptEvidence.create({
        data: { id: randomUUID(), saleId, tenantId, status: 'PENDING' },
      }),
    ).rejects.toThrow();
  });
});
