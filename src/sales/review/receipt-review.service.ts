import { Inject, Injectable, Optional } from '@nestjs/common';
import { SalesService } from '../sales.service';
import {
  InvalidReceiptCursorError,
  ReceiptNotActionableError,
  SaleNotReviewableError,
} from './domain/receipt-review.errors';
import {
  RECEIPT_REVIEW_REPOSITORY,
  type ReceiptQueuePosition,
  type ReceiptReviewRecord,
  type ReceiptReviewRepository,
} from './domain/receipt-review.repository';
import {
  SALE_REPOSITORY,
  type ISaleRepository,
} from '../domain/sale.repository';
import { ChatbotRequestWrapper } from '../../chatbot-requests/infrastructure/chatbot-request-wrapper';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { ConfirmReceiptDto } from './dto/confirm-receipt.dto';
import type { RejectReceiptDto } from './dto/reject-receipt.dto';
import type {
  ReceiptReviewFileDto,
  ReceiptReviewQueueItemDto,
  ReceiptReviewQueueResponseDto,
  TenantReceiptQueuePageDto,
} from './dto/receipt-review-queue.dto';
import { OutboxWriterService } from '../../shared/outbox/outbox-writer.service';
import {
  ReceiptConfirmedEvent,
  ReceiptRejectedEvent,
} from '../domain/events/sale.events';

type ConfirmReceiptResult = {
  saleId: string;
  paidCents: number;
  debtCents: number;
  totalCents: number;
  paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT';
  paymentIds: string[];
};

type ReceiptConfirmedEventSeamInput = {
  receipt: ReceiptReviewRecord;
  reviewerUserId: string;
  amountCents: number;
  paymentResult: ConfirmReceiptResult;
  confirmedAt: Date;
};

/**
 * Customer-safe text stored when a reviewer rejects with the v1 body (no
 * `customerReason`). The chatbot relays it as-is; the internal reason never
 * leaves the backend.
 */
export const DEFAULT_CUSTOMER_REJECTION_REASON =
  'No pudimos validar tu comprobante. Por favor envíanos uno nuevo o contáctanos.';

const DEFAULT_QUEUE_LIMIT = 25;
const MAX_QUEUE_LIMIT = 100;

type ReceiptRejectedEventSeamInput = {
  receipt: ReceiptReviewRecord;
  reviewerUserId: string;
  reason: string;
};

@Injectable()
export class ReceiptReviewService {
  constructor(
    @Inject(RECEIPT_REVIEW_REPOSITORY)
    private readonly receiptReviewRepository: ReceiptReviewRepository,
    private readonly salesService: SalesService,
    @Inject(SALE_REPOSITORY)
    private readonly saleRepository: ISaleRepository,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outboxWriter: OutboxWriterService,
    // Optional so specs that build the service alone keep their behavior; the
    // module always provides it (unit 3 wrapping).
    @Optional() private readonly wrapper?: ChatbotRequestWrapper,
  ) {}

  /**
   * Lists actionable receipt evidence for one sale in the active tenant.
   * The controller enforces `ReceiptEvidence:read`; this method keeps the
   * tenant filter inside the repository boundary and returns only `PENDING`
   * receipt rows mapped for the review queue.
   */
  async listPending(saleId: string): Promise<ReceiptReviewQueueResponseDto> {
    const tenantId = this.tenantPrisma.getTenantId();
    const receipts = await this.receiptReviewRepository.findPendingForSale(
      saleId,
      tenantId,
    );

    return receipts.map(mapQueueItem);
  }

  /**
   * Tenant-wide review worklist: pending receipts of every confirmed sale,
   * oldest first, keyset-paged with an opaque cursor. Each item is the
   * per-sale queue item plus the sale folio and customer name.
   */
  async listPendingForTenant(query: {
    limit?: number;
    cursor?: string;
  }): Promise<TenantReceiptQueuePageDto> {
    const tenantId = this.tenantPrisma.getTenantId();
    const limit = Math.min(
      Math.max(query.limit ?? DEFAULT_QUEUE_LIMIT, 1),
      MAX_QUEUE_LIMIT,
    );
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = await this.receiptReviewRepository.findPendingForTenant(
      tenantId,
      { limit: limit + 1, after },
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];

    return {
      items: page.map((receipt) => ({
        ...mapQueueItem(receipt),
        saleFolio: receipt.sale.folio,
        customerName: receipt.sale.customerName,
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  /**
   * Confirms a pending receipt and applies its real transfer amount.
   * The controller enforces `ReceiptEvidence:update` and supplies the reviewer
   * id plus idempotency key. The method guards receipt and sale state before a
   * transaction that claims the receipt, records the shared sale payment,
   * and emits the receipt confirmation outbox event.
   */
  async confirm(
    saleId: string,
    receiptId: string,
    reviewerUserId: string,
    dto: ConfirmReceiptDto,
    idempotencyKey: string,
  ): Promise<ConfirmReceiptResult> {
    const tenantId = this.tenantPrisma.getTenantId();
    const receipt = await this.loadActionableReceipt(
      receiptId,
      tenantId,
      saleId,
    );
    this.ensureSaleReviewable(receipt);

    return this.saleRepository.runInTransaction(async () => {
      // Lock order: the wrapping request before the receipt row (unit 3).
      await this.wrapper?.lockLegacy({ receiptEvidenceId: receiptId });
      const confirmedAt = new Date();
      const claimed = await this.receiptReviewRepository.markConfirmed(
        receiptId,
        tenantId,
        reviewerUserId,
        confirmedAt,
      );
      if (!claimed) throw new ReceiptNotActionableError();

      const paymentResult = (await this.salesService.addPayment(
        saleId,
        reviewerUserId,
        {
          method: 'transfer',
          amountCents: dto.amountCents,
          reference: receipt.declaredReference ?? undefined,
        },
        idempotencyKey,
        'reviewer',
      )) as ConfirmReceiptResult;

      await this.publishReceiptConfirmedEventSeam({
        receipt,
        reviewerUserId,
        amountCents: dto.amountCents,
        paymentResult,
        confirmedAt,
      });
      await this.wrapper?.closeLegacy(
        { receiptEvidenceId: receiptId },
        { userId: reviewerUserId },
        'CONFIRM_RECEIPT',
        { amountCents: dto.amountCents },
      );

      return paymentResult;
    });
  }

  /**
   * Rejects a pending receipt with the reviewer-provided internal reason and
   * a customer-safe reason (a generic default for the v1 body).
   * The controller enforces `ReceiptEvidence:update`; this method guards the
   * receipt state before a short transaction that stores the rejection reason
   * and emits the receipt rejection outbox event without touching sale payment.
   */
  async reject(
    saleId: string,
    receiptId: string,
    reviewerUserId: string,
    dto: RejectReceiptDto,
  ): Promise<void> {
    const tenantId = this.tenantPrisma.getTenantId();
    const receipt = await this.loadActionableReceipt(
      receiptId,
      tenantId,
      saleId,
    );

    await this.saleRepository.runInTransaction(async () => {
      await this.wrapper?.lockLegacy({ receiptEvidenceId: receiptId });
      const claimed = await this.receiptReviewRepository.markRejected(
        receiptId,
        tenantId,
        dto.reason,
        dto.customerReason ?? DEFAULT_CUSTOMER_REJECTION_REASON,
      );
      if (!claimed) throw new ReceiptNotActionableError();

      await this.publishReceiptRejectedEventSeam({
        receipt,
        reviewerUserId,
        reason: dto.reason,
      });
      await this.wrapper?.closeLegacy(
        { receiptEvidenceId: receiptId },
        { userId: reviewerUserId },
        'REJECT_RECEIPT',
        { reason: dto.reason },
      );
    });
  }

  private async loadActionableReceipt(
    receiptId: string,
    tenantId: string,
    saleId: string,
  ): Promise<ReceiptReviewRecord> {
    const receipt = await this.receiptReviewRepository.findById(
      receiptId,
      tenantId,
    );

    if (!receipt || receipt.saleId !== saleId || receipt.status !== 'PENDING') {
      throw new ReceiptNotActionableError();
    }

    return receipt;
  }

  private ensureSaleReviewable(receipt: ReceiptReviewRecord): void {
    if (receipt.sale.status !== 'CONFIRMED') {
      throw new SaleNotReviewableError();
    }

    if (receipt.sale.paymentStatus === 'PAID' || receipt.sale.debtCents <= 0) {
      throw new SaleNotReviewableError();
    }
  }

  private async publishReceiptConfirmedEventSeam(
    input: ReceiptConfirmedEventSeamInput,
  ): Promise<void> {
    const occurredAt = input.confirmedAt.toISOString();

    await this.outboxWriter.publish(
      this.tenantPrisma.getClient(),
      input.receipt.tenantId,
      'ReceiptEvidence',
      input.receipt.id,
      'receipt.confirmed',
      {
        ...new ReceiptConfirmedEvent(
          input.receipt.id,
          input.receipt.saleId,
          input.receipt.tenantId,
          input.amountCents,
          'TRANSFER',
          { kind: 'bot', channel: input.receipt.sale.channel },
          input.reviewerUserId,
          input.confirmedAt.toISOString(),
          input.paymentResult.paymentStatus,
          occurredAt,
        ),
      },
    );
  }

  private async publishReceiptRejectedEventSeam(
    input: ReceiptRejectedEventSeamInput,
  ): Promise<void> {
    const occurredAt = new Date().toISOString();

    await this.outboxWriter.publish(
      this.tenantPrisma.getClient(),
      input.receipt.tenantId,
      'ReceiptEvidence',
      input.receipt.id,
      'receipt.rejected',
      {
        ...new ReceiptRejectedEvent(
          input.receipt.id,
          input.receipt.saleId,
          input.receipt.tenantId,
          input.reviewerUserId,
          input.reason,
          occurredAt,
        ),
      },
    );
  }
}

function mapQueueItem(receipt: ReceiptReviewRecord): ReceiptReviewQueueItemDto {
  return {
    id: receipt.id,
    saleId: receipt.saleId,
    mediaUrl: receipt.mediaUrl,
    declaredAmountCents: receipt.declaredAmountCents,
    declaredDate: receipt.declaredDate,
    declaredReference: receipt.declaredReference,
    status: receipt.status,
    salePaymentStatus: receipt.sale.paymentStatus,
    salePaidCents: receipt.sale.paidCents,
    saleDebtCents: receipt.sale.debtCents,
    saleTotalCents: receipt.sale.totalCents,
    declaredAmountProvided: receipt.declaredAmountProvided,
    file: mapFile(receipt),
    extracted: receipt.extracted,
    mismatch: receipt.mismatch,
    createdAt: receipt.createdAt,
  };
}

function mapFile(receipt: ReceiptReviewRecord): ReceiptReviewFileDto | null {
  if (!receipt.file) return null;
  const base = `/sales/${receipt.saleId}/receipts/${receipt.id}`;
  const { purged, ...file } = receipt.file;
  return {
    ...file,
    originalUrl: purged ? null : `${base}/file`,
    previewUrl:
      purged || file.previewStatus !== 'READY' ? null : `${base}/preview`,
  };
}

function encodeCursor(position: ReceiptQueuePosition): string {
  return Buffer.from(
    JSON.stringify([position.createdAt.toISOString(), position.id]),
  ).toString('base64url');
}

function decodeCursor(cursor: string): ReceiptQueuePosition {
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (
      Array.isArray(decoded) &&
      decoded.length === 2 &&
      typeof decoded[0] === 'string' &&
      typeof decoded[1] === 'string'
    ) {
      const createdAt = new Date(decoded[0]);
      if (!Number.isNaN(createdAt.getTime())) {
        return { createdAt, id: decoded[1] };
      }
    }
  } catch {
    // fall through
  }
  throw new InvalidReceiptCursorError();
}
