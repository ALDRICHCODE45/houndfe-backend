import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  assertReceiptFile,
  type ReceiptMimeType,
} from '../domain/receipt-file';
import { parseReceiptUploadFields } from '../domain/receipt-fields';
import { computeReceiptMismatch } from '../domain/receipt-mismatch';
import {
  RECEIPT_PREVIEW_RASTERIZER,
  RECEIPT_STORAGE,
  type ReceiptPreviewRasterizer,
  type ReceiptStoragePort,
} from '../domain/receipt-storage.port';
import { ReceiptUploadError } from '../domain/receipt-upload.errors';

export type ReceiptUploadResponse = {
  receiptId: string;
  status: 'PENDING';
  mimeType: ReceiptMimeType;
  sizeBytes: number;
  sha256: string;
  previewStatus: 'READY' | 'UNAVAILABLE';
};

export type LegacyReceiptInput = {
  saleId: string;
  mediaUrl: string;
  declaredAmountCents: number | null;
  declaredDate: Date | null;
  declaredReference: string | null;
};

const EXTENSIONS: Record<ReceiptMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
};

type StoredReceipt = {
  id: string;
  mimeType: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  previewStatus: 'READY' | 'UNAVAILABLE' | null;
};

/**
 * Accepts a chatbot transfer receipt: validates bytes and fields, enforces
 * the sale rules, stores the original (and a PDF preview) privately and
 * records a PENDING receipt that a human always reviews.
 */
@Injectable()
export class ReceiptUploadService {
  private readonly logger = new Logger(ReceiptUploadService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    @Inject(RECEIPT_STORAGE) private readonly storage: ReceiptStoragePort,
    @Inject(RECEIPT_PREVIEW_RASTERIZER)
    private readonly rasterizer: ReceiptPreviewRasterizer,
  ) {}

  async upload(input: {
    saleId: string;
    idempotencyKey: string;
    file: Buffer | undefined;
    fields: unknown;
  }): Promise<ReceiptUploadResponse> {
    const fields = parseReceiptUploadFields(input.fields);
    const { mimeType, sizeBytes } = assertReceiptFile(input.file);
    const bytes = input.file as Buffer;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const tenantId = this.tenantPrisma.getTenantId();

    // Replay first: a retry after the sale got paid still returns its receipt.
    const existing = await this.findByKey(
      tenantId,
      input.saleId,
      input.idempotencyKey,
    );
    if (existing) return this.replay(existing, sha256);

    const debtCents = await this.assertPayableSale(tenantId, input.saleId);

    const base = `receipts/${tenantId}/${input.saleId}/${randomUUID()}`;
    const storageKey = `${base}.${EXTENSIONS[mimeType]}`;
    try {
      await this.storage.putPrivate({ key: storageKey, bytes, mimeType });
    } catch (error) {
      this.logger.error(
        `Receipt upload to private storage failed: ${(error as Error).message}`,
      );
      throw new ReceiptUploadError(
        'RECEIPT_STORAGE_FAILED',
        'Receipt could not be stored, retry with the same idempotency key',
      );
    }

    const preview = await this.storePreview(base, storageKey, mimeType, bytes);
    const mismatch = computeReceiptMismatch({
      debtCents,
      declared: fields.declaredAmountCents,
      extracted: fields.extracted?.amountCents ?? null,
    });

    try {
      const row = await this.tenantPrisma.getClient().receiptEvidence.create({
        data: {
          id: randomUUID(),
          saleId: input.saleId,
          tenantId,
          declaredAmountCents: fields.declaredAmountCents,
          declaredDate: fields.declaredDate,
          declaredReference: fields.declaredReference,
          extracted: fields.extracted ?? Prisma.DbNull,
          storageKey,
          mimeType,
          sizeBytes,
          sha256,
          previewKey: preview.key,
          previewMimeType: preview.key ? 'image/png' : null,
          previewStatus: preview.status,
          idempotencyKey: input.idempotencyKey,
          mismatch,
          status: 'PENDING',
        },
      });
      return toResponse(row);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent request with the same key won the insert: drop our
      // objects and answer like a replay of the winner.
      await this.storage.delete(storageKey);
      if (preview.key && preview.key !== storageKey) {
        await this.storage.delete(preview.key);
      }
      const winner = await this.findByKey(
        tenantId,
        input.saleId,
        input.idempotencyKey,
      );
      if (!winner) throw error;
      return this.replay(winner, sha256);
    }
  }

  /**
   * Legacy JSON `mediaUrl` attachment, kept until the chatbot confirms the
   * multipart migration. Same sale rules; no idempotency (as before).
   */
  async attachLegacyUrl(
    input: LegacyReceiptInput,
  ): Promise<{ receiptId: string; status: 'PENDING' }> {
    const tenantId = this.tenantPrisma.getTenantId();
    const debtCents = await this.assertPayableSale(tenantId, input.saleId);
    const row = await this.tenantPrisma.getClient().receiptEvidence.create({
      data: {
        id: randomUUID(),
        saleId: input.saleId,
        tenantId,
        mediaUrl: input.mediaUrl,
        declaredAmountCents: input.declaredAmountCents,
        declaredDate: input.declaredDate,
        declaredReference: input.declaredReference,
        mismatch: computeReceiptMismatch({
          debtCents,
          declared: input.declaredAmountCents,
          extracted: null,
        }),
        status: 'PENDING',
      },
    });
    return { receiptId: row.id, status: 'PENDING' };
  }

  private findByKey(
    tenantId: string,
    saleId: string,
    idempotencyKey: string,
  ): Promise<StoredReceipt | null> {
    return this.tenantPrisma.getClient().receiptEvidence.findFirst({
      where: { tenantId, saleId, idempotencyKey },
      select: {
        id: true,
        mimeType: true,
        sizeBytes: true,
        sha256: true,
        previewStatus: true,
      },
    });
  }

  private replay(
    existing: StoredReceipt,
    sha256: string,
  ): ReceiptUploadResponse {
    if (existing.sha256 !== sha256) {
      throw new ReceiptUploadError(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency key was already used for a different file on this sale',
      );
    }
    return toResponse(existing);
  }

  /** @returns the current sale debt (source of truth for the mismatch). */
  private async assertPayableSale(
    tenantId: string,
    saleId: string,
  ): Promise<number> {
    const sale = await this.tenantPrisma.getClient().sale.findFirst({
      where: { id: saleId, tenantId },
      select: { status: true, paymentStatus: true, debtCents: true },
    });
    if (!sale) {
      throw new ReceiptUploadError('SALE_NOT_FOUND', 'Sale not found');
    }
    if (sale.status !== 'CONFIRMED') {
      throw new ReceiptUploadError(
        'SALE_NOT_PAYABLE',
        'Sale is canceled or not confirmed',
      );
    }
    if (sale.paymentStatus === 'PAID' || sale.debtCents <= 0) {
      throw new ReceiptUploadError('SALE_ALREADY_PAID', 'Sale is already paid');
    }
    return sale.debtCents;
  }

  /**
   * Images are their own preview. PDFs get a first-page PNG; any failure
   * keeps the original and marks the preview UNAVAILABLE.
   */
  private async storePreview(
    base: string,
    storageKey: string,
    mimeType: ReceiptMimeType,
    bytes: Buffer,
  ): Promise<{ key: string | null; status: 'READY' | 'UNAVAILABLE' }> {
    if (mimeType !== 'application/pdf') {
      return { key: storageKey, status: 'READY' };
    }
    const previewKey = `${base}.preview.png`;
    try {
      const preview = await this.rasterizer.rasterizeFirstPage(bytes);
      await this.storage.putPrivate({
        key: previewKey,
        bytes: preview.bytes,
        mimeType: preview.mimeType,
      });
      return { key: previewKey, status: 'READY' };
    } catch (error) {
      this.logger.warn(
        `Receipt PDF preview unavailable for ${storageKey}: ${(error as Error).message}`,
      );
      return { key: null, status: 'UNAVAILABLE' };
    }
  }
}

function toResponse(row: StoredReceipt): ReceiptUploadResponse {
  return {
    receiptId: row.id,
    status: 'PENDING',
    mimeType: row.mimeType as ReceiptMimeType,
    sizeBytes: row.sizeBytes as number,
    sha256: row.sha256 as string,
    previewStatus: row.previewStatus ?? 'UNAVAILABLE',
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
