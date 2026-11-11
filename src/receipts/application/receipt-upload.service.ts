import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { ChatbotRequestWrapper } from '../../chatbot-requests/infrastructure/chatbot-request-wrapper';
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
import {
  RECEIPT_REVIEW_REQUESTED_EVENT_TYPE,
  type ReceiptReviewRequestedPayload,
} from '../domain/receipt-review-requested.event';
import {
  NOTIFICATION_CONFIG_REPOSITORY,
  type INotificationConfigRepository,
} from '../../notification-config/domain/notification-config.repository';
import { OutboxWriterService } from '../../shared/outbox/outbox-writer.service';
import type { OutboxPayload } from '../../shared/outbox/outbox.types';

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

type PayableSale = {
  debtCents: number;
  folio: string | null;
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
    @Inject(NOTIFICATION_CONFIG_REPOSITORY)
    private readonly notificationConfig: Pick<
      INotificationConfigRepository,
      'find'
    >,
    private readonly outboxWriter: OutboxWriterService,
    // Optional so specs that build the service alone keep their behavior; the
    // module always provides it (unit 3 wrapping).
    @Optional() private readonly wrapper?: ChatbotRequestWrapper,
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

    const sale = await this.assertPayableSale(tenantId, input.saleId);

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
      debtCents: sale.debtCents,
      declared: fields.declaredAmountCents,
      extracted: fields.extracted?.amountCents ?? null,
    });

    try {
      const row = await this.createWithReviewRequest(
        {
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
        sale,
      );
      return toResponse(row);
    } catch (error) {
      // No row points at our objects any more: drop them. A concurrent
      // request with the same key that won the insert is answered like a
      // replay of the winner; any other failure is rethrown unchanged.
      await this.discardObjects(storageKey, preview.key);
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.findByKey(
        tenantId,
        input.saleId,
        input.idempotencyKey,
      );
      if (!winner) throw error;
      return this.replay(winner, sha256);
    }
  }

  /** Best effort: a failed delete is logged and never masks the caller's error. */
  private async discardObjects(
    storageKey: string,
    previewKey: string | null,
  ): Promise<void> {
    const keys = [...new Set([storageKey, previewKey])].filter(
      (key): key is string => Boolean(key),
    );
    for (const key of keys) {
      try {
        await this.storage.delete(key);
      } catch (error) {
        this.logger.error(
          `Orphaned receipt object ${key} could not be deleted: ${(error as Error).message}`,
        );
      }
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
    const sale = await this.assertPayableSale(tenantId, input.saleId);
    const row = await this.createWithReviewRequest(
      {
        id: randomUUID(),
        saleId: input.saleId,
        tenantId,
        mediaUrl: input.mediaUrl,
        declaredAmountCents: input.declaredAmountCents,
        declaredDate: input.declaredDate,
        declaredReference: input.declaredReference,
        mismatch: computeReceiptMismatch({
          debtCents: sale.debtCents,
          declared: input.declaredAmountCents,
          extracted: null,
        }),
        status: 'PENDING',
      },
      sale,
    );
    return { receiptId: row.id, status: 'PENDING' };
  }

  /**
   * Inserts the receipt and, when the tenant enabled RECEIPT_REVIEW_REQUESTED,
   * the staff-email outbox row in the same transaction. A unique violation
   * rolls both back, so a lost concurrent race never emails twice.
   */
  private createWithReviewRequest(
    data: Prisma.ReceiptEvidenceUncheckedCreateInput & {
      id: string;
      tenantId: string;
    },
    sale: PayableSale,
  ) {
    return this.tenantPrisma.runInTransaction(async () => {
      const prisma = this.tenantPrisma.getClient();
      const row = await prisma.receiptEvidence.create({ data });
      await this.wrapper?.wrapReceipt({ id: row.id, saleId: data.saleId });

      const config = await this.notificationConfig.find();
      if (
        config.enabled &&
        config.enabledActions.includes('RECEIPT_REVIEW_REQUESTED')
      ) {
        const extracted = data.extracted as { amountCents?: number } | null;
        const mismatch = data.mismatch as { flagged?: boolean } | null;
        const payload: ReceiptReviewRequestedPayload = {
          tenantId: data.tenantId,
          receiptId: row.id,
          saleId: data.saleId,
          saleFolio: sale.folio,
          declaredAmountCents: data.declaredAmountCents ?? null,
          extractedAmountCents: extracted?.amountCents ?? null,
          debtCents: sale.debtCents,
          mismatchFlagged: mismatch?.flagged ?? false,
          mimeType: data.mimeType ?? null,
        };
        await this.outboxWriter.publish(
          prisma as unknown as Parameters<OutboxWriterService['publish']>[0],
          data.tenantId,
          'ReceiptEvidence',
          row.id,
          RECEIPT_REVIEW_REQUESTED_EVENT_TYPE,
          payload as unknown as OutboxPayload,
        );
      }
      return row;
    });
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

  /**
   * @returns the current sale debt (source of truth for the mismatch) and
   * the header the staff email shows.
   */
  private async assertPayableSale(
    tenantId: string,
    saleId: string,
  ): Promise<PayableSale> {
    const sale = await this.tenantPrisma.getClient().sale.findFirst({
      where: { id: saleId, tenantId },
      select: {
        status: true,
        paymentStatus: true,
        debtCents: true,
        folio: true,
      },
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
    return {
      debtCents: sale.debtCents,
      folio: sale.folio,
    };
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
