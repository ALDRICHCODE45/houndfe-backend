/**
 * INTEGRATION SPEC: bot outcome poll (GET /chatbot-api/receipts/:receiptId)
 * against the real `nest-practice-test` DB (port 5433 — NEVER dev).
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { ReceiptReadError } from '../domain/receipt-read.errors';
import { ReceiptStatusService } from './receipt-status.service';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

describeIfDb('ReceiptStatusService (Integration)', () => {
  let prisma: PrismaClient;
  let service: ReceiptStatusService;
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
    service = new ReceiptStatusService(
      new TenantPrismaService(
        prisma as unknown as ConstructorParameters<
          typeof TenantPrismaService
        >[0],
        cls,
      ),
    );
    for (const id of [tenantId, otherTenantId]) {
      await prisma.tenant.create({
        data: { id, name: 'Receipt status', slug: `rs-${id.slice(0, 8)}` },
      });
    }
    await prisma.user.create({
      data: {
        id: userId,
        email: `rs-${userId.slice(0, 8)}@example.com`,
        hashedPassword: 'x',
        name: 'Receipt status',
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
        paidCents: 4_000,
        debtCents: 6_000,
        paymentStatus: 'PARTIAL',
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
    currentTenantId = tenantId;
  });

  async function createReceipt(
    status: 'PENDING' | 'CONFIRMED' | 'REJECTED',
  ): Promise<string> {
    const id = randomUUID();
    await prisma.receiptEvidence.create({
      data: {
        id,
        saleId,
        tenantId,
        storageKey: `receipts/${tenantId}/${saleId}/${randomUUID()}.png`,
        mimeType: 'image/png',
        previewKey: 'k',
        previewStatus: 'READY',
        extracted: { amountCents: 6000 },
        mismatch: { debtCents: 6000, flagged: false },
        status,
        rejectionReason: status === 'REJECTED' ? 'Fraude interno' : null,
        customerReason:
          status === 'REJECTED' ? 'El monto no coincide con tu pedido.' : null,
        confirmedByUserId: status === 'CONFIRMED' ? userId : null,
      },
    });
    return id;
  }

  it('answers PENDING with the live sale debt and nothing else', async () => {
    const receiptId = await createReceipt('PENDING');

    await expect(service.getForBot(receiptId)).resolves.toEqual({
      status: 'PENDING',
      sale: { debtCents: 6000, paymentStatus: 'PARTIAL' },
    });
  });

  it('answers CONFIRMED without reviewer data', async () => {
    const receiptId = await createReceipt('CONFIRMED');

    await expect(service.getForBot(receiptId)).resolves.toEqual({
      status: 'CONFIRMED',
      sale: { debtCents: 6000, paymentStatus: 'PARTIAL' },
    });
  });

  it('answers REJECTED with the customer reason only, never the internal one', async () => {
    const receiptId = await createReceipt('REJECTED');

    const outcome = await service.getForBot(receiptId);

    expect(outcome).toEqual({
      status: 'REJECTED',
      customerReason: 'El monto no coincide con tu pedido.',
      sale: { debtCents: 6000, paymentStatus: 'PARTIAL' },
    });
    expect(JSON.stringify(outcome)).not.toMatch(
      /Fraude|receipts\/|storage|extracted|mismatch|confirmedBy/,
    );
  });

  it('answers 404 RECEIPT_NOT_FOUND for another tenant or an unknown id', async () => {
    const receiptId = await createReceipt('PENDING');
    currentTenantId = otherTenantId;

    for (const id of [receiptId, randomUUID()]) {
      const error = await service.getForBot(id).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ReceiptReadError);
      expect(error).toMatchObject({
        code: 'RECEIPT_NOT_FOUND',
        httpStatus: 404,
      });
    }
  });
});
