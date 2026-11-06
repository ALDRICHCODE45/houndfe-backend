/**
 * INTEGRATION SPEC: staff private read path for receipt files against the
 * real `nest-practice-test` DB (port 5433 — NEVER dev). Storage is an
 * in-memory fake (no network). Auth guards are test doubles that read the
 * tenant and permissions from headers; the controller, service, filter and
 * tenant-scoped Prisma reads are real.
 */
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import {
  ForbiddenException,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import request from 'supertest';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import {
  RECEIPT_STORAGE,
  type ReceiptStoragePort,
} from '../domain/receipt-storage.port';
import { ReceiptFileService } from '../application/receipt-file.service';
import { ReceiptFileController } from './receipt-file.controller';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

class FakeStorage implements ReceiptStoragePort {
  readonly objects = new Map<string, Buffer>();
  failReads = false;

  putPrivate(input: { key: string; bytes: Buffer }) {
    this.objects.set(input.key, input.bytes);
    return Promise.resolve();
  }

  delete(key: string) {
    this.objects.delete(key);
    return Promise.resolve();
  }

  remove(key: string) {
    this.objects.delete(key);
    return Promise.resolve();
  }

  getPrivate(key: string) {
    if (this.failReads) return Promise.reject(new Error('spaces down'));
    const bytes = this.objects.get(key);
    if (!bytes) return Promise.resolve(null);
    return Promise.resolve({
      body: Readable.from([bytes]),
      contentLength: bytes.length,
    });
  }
}

let currentTenantId = '';

type HeaderRequest = {
  headers: Record<string, string | undefined>;
  user?: { userId: string; tenantId: string; permissions: string[] };
};

class TestJwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HeaderRequest>();
    currentTenantId = req.headers['x-test-tenant'] ?? '';
    req.user = {
      userId: 'reviewer',
      tenantId: currentTenantId,
      permissions: (req.headers['x-test-permissions'] ?? '')
        .split(',')
        .filter(Boolean),
    };
    return true;
  }
}

class AllowGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

class TestPermissionsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HeaderRequest>();
    const required = (Reflect.getMetadata(
      'required_permissions',
      context.getHandler(),
    ) ?? []) as Array<[string, string]>;
    for (const [action, subject] of required) {
      if (!req.user?.permissions.includes(`${action}:${subject}`)) {
        throw new ForbiddenException('Insufficient permissions');
      }
    }
    return true;
  }
}

describeIfDb('Receipt file routes (Integration)', () => {
  let prisma: PrismaClient;
  let app: INestApplication;
  const storage = new FakeStorage();
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const userId = randomUUID();
  let saleId: string;
  const READ = 'read:ReceiptEvidence';

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

    for (const id of [tenantId, otherTenantId]) {
      await prisma.tenant.create({
        data: { id, name: 'Receipt files', slug: `rf-${id.slice(0, 8)}` },
      });
    }
    await prisma.user.create({
      data: {
        id: userId,
        email: `rf-${userId.slice(0, 8)}@example.com`,
        hashedPassword: 'x',
        name: 'Receipt files',
        isActive: true,
      },
    });
    saleId = randomUUID();
    await prisma.sale.create({
      data: {
        id: saleId,
        tenantId,
        userId,
        status: 'CONFIRMED',
        channel: 'ONLINE',
        totalCents: 10_000,
        paidCents: 0,
        debtCents: 10_000,
        paymentStatus: 'CREDIT',
      },
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [ReceiptFileController],
      providers: [
        ReceiptFileService,
        { provide: TenantPrismaService, useValue: tenantPrisma },
        { provide: RECEIPT_STORAGE, useValue: storage },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(TestJwtAuthGuard)
      .overrideGuard(TenantContextGuard)
      .useClass(AllowGuard)
      .overrideGuard(PermissionsGuard)
      .useClass(TestPermissionsGuard)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await prisma.tenant.deleteMany({
      where: { id: { in: [tenantId, otherTenantId] } },
    });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  beforeEach(() => {
    storage.failReads = false;
  });

  async function createReceipt(
    data: Partial<{
      mediaUrl: string | null;
      storageKey: string | null;
      mimeType: string | null;
      previewKey: string | null;
      previewStatus: 'READY' | 'UNAVAILABLE' | null;
      purgedAt: Date | null;
    }>,
  ): Promise<string> {
    const id = randomUUID();
    await prisma.receiptEvidence.create({
      data: {
        id,
        saleId,
        tenantId,
        mediaUrl: data.mediaUrl ?? null,
        storageKey: data.storageKey ?? null,
        mimeType: data.mimeType ?? null,
        previewKey: data.previewKey ?? null,
        previewMimeType: data.previewKey ? 'image/png' : null,
        previewStatus: data.previewStatus ?? null,
        purgedAt: data.purgedAt ?? null,
        status: 'PENDING',
      },
    });
    return id;
  }

  async function createPdfReceipt(): Promise<string> {
    const base = `receipts/${tenantId}/${saleId}/${randomUUID()}`;
    storage.objects.set(`${base}.pdf`, Buffer.from('%PDF-1.4 original'));
    storage.objects.set(`${base}.preview.png`, Buffer.from('png-preview'));
    return createReceipt({
      storageKey: `${base}.pdf`,
      mimeType: 'application/pdf',
      previewKey: `${base}.preview.png`,
      previewStatus: 'READY',
    });
  }

  const get = (path: string, tenant = tenantId, permissions = READ) =>
    request(app.getHttpServer() as Parameters<typeof request>[0])
      .get(path)
      .set('x-test-tenant', tenant)
      .set('x-test-permissions', permissions)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });

  it('streams the original with private, inline, nosniff headers', async () => {
    const receiptId = await createPdfReceipt();

    const res = await get(`/sales/${saleId}/receipts/${receiptId}/file`);

    expect(res.status).toBe(200);
    expect((res.body as Buffer).toString()).toBe('%PDF-1.4 original');
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toBe(
      `inline; filename="comprobante-${receiptId}.pdf"`,
    );
    expect(res.headers['content-length']).toBe('17');
  });

  it('streams the PDF preview as PNG', async () => {
    const receiptId = await createPdfReceipt();

    const res = await get(`/sales/${saleId}/receipts/${receiptId}/preview`);

    expect(res.status).toBe(200);
    expect((res.body as Buffer).toString()).toBe('png-preview');
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['content-disposition']).toBe(
      `inline; filename="comprobante-${receiptId}-vista-previa.png"`,
    );
  });

  it('answers 404 RECEIPT_NOT_FOUND for another tenant', async () => {
    const receiptId = await createPdfReceipt();

    const res = await get(
      `/sales/${saleId}/receipts/${receiptId}/file`,
      otherTenantId,
    );

    expect(res.status).toBe(404);
    expect(JSON.parse((res.body as Buffer).toString())).toMatchObject({
      statusCode: 404,
      error: 'RECEIPT_NOT_FOUND',
    });
  });

  it('answers 404 RECEIPT_NOT_FOUND when the receipt is on another sale', async () => {
    const receiptId = await createPdfReceipt();

    const res = await get(`/sales/${randomUUID()}/receipts/${receiptId}/file`);

    expect(res.status).toBe(404);
  });

  it('answers 403 without read ReceiptEvidence', async () => {
    const receiptId = await createPdfReceipt();

    const res = await get(
      `/sales/${saleId}/receipts/${receiptId}/file`,
      tenantId,
      'read:Sale',
    );

    expect(res.status).toBe(403);
  });

  it('answers 404 RECEIPT_FILE_NOT_AVAILABLE for a legacy mediaUrl row', async () => {
    const receiptId = await createReceipt({
      mediaUrl: 'https://legacy.example/r.jpg',
    });

    const res = await get(`/sales/${saleId}/receipts/${receiptId}/file`);

    expect(res.status).toBe(404);
    expect(JSON.parse((res.body as Buffer).toString())).toMatchObject({
      error: 'RECEIPT_FILE_NOT_AVAILABLE',
    });
  });

  it('answers 404 RECEIPT_FILE_NOT_AVAILABLE when the preview is unavailable', async () => {
    const key = `receipts/${tenantId}/${saleId}/${randomUUID()}.pdf`;
    storage.objects.set(key, Buffer.from('%PDF-1.4'));
    const receiptId = await createReceipt({
      storageKey: key,
      mimeType: 'application/pdf',
      previewStatus: 'UNAVAILABLE',
    });

    const res = await get(`/sales/${saleId}/receipts/${receiptId}/preview`);

    expect(res.status).toBe(404);
    expect(JSON.parse((res.body as Buffer).toString())).toMatchObject({
      error: 'RECEIPT_FILE_NOT_AVAILABLE',
    });
  });

  it('answers 410 RECEIPT_FILE_PURGED after retention', async () => {
    const receiptId = await createReceipt({ purgedAt: new Date() });

    const res = await get(`/sales/${saleId}/receipts/${receiptId}/file`);

    expect(res.status).toBe(410);
    expect(JSON.parse((res.body as Buffer).toString())).toMatchObject({
      error: 'RECEIPT_FILE_PURGED',
    });
  });

  it('answers 502 RECEIPT_STORAGE_FAILED when storage fails', async () => {
    const receiptId = await createPdfReceipt();
    storage.failReads = true;

    const res = await get(`/sales/${saleId}/receipts/${receiptId}/file`);

    expect(res.status).toBe(502);
    expect(JSON.parse((res.body as Buffer).toString())).toMatchObject({
      error: 'RECEIPT_STORAGE_FAILED',
    });
  });

  it('answers 404 RECEIPT_FILE_NOT_AVAILABLE when the object is missing', async () => {
    const receiptId = await createReceipt({
      storageKey: `receipts/${tenantId}/${saleId}/${randomUUID()}.png`,
      mimeType: 'image/png',
    });

    const res = await get(`/sales/${saleId}/receipts/${receiptId}/file`);

    expect(res.status).toBe(404);
  });
});
