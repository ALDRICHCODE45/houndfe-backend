import { Inject, Injectable } from '@nestjs/common';
import { SalesService } from '../sales.service';
import {
  ReceiptNotActionableError,
  SaleNotReviewableError,
} from './domain/receipt-review.errors';
import {
  RECEIPT_REVIEW_REPOSITORY,
  type ReceiptReviewRecord,
  type ReceiptReviewRepository,
} from './domain/receipt-review.repository';
import {
  SALE_REPOSITORY,
  type ISaleRepository,
} from '../domain/sale.repository';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { ConfirmReceiptDto } from './dto/confirm-receipt.dto';
import type { RejectReceiptDto } from './dto/reject-receipt.dto';
import type {
  ReceiptReviewQueueItemDto,
  ReceiptReviewQueueResponseDto,
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
   * Confirms a pending receipt and applies its real transfer amount.
   * The controller enforces `ReceiptEvidence:update` and supplies the reviewer
   * id plus idempotency key. The method guards receipt and sale state before a
   * transaction that records the shared sale payment, marks the receipt as
   * confirmed, and emits the receipt confirmation outbox event.
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

      const confirmedAt = new Date();
      await this.receiptReviewRepository.markConfirmed(
        receiptId,
        tenantId,
        reviewerUserId,
        confirmedAt,
      );
      await this.publishReceiptConfirmedEventSeam({
        receipt,
        reviewerUserId,
        amountCents: dto.amountCents,
        paymentResult,
        confirmedAt,
      });

      return paymentResult;
    });
  }

  /**
   * Rejects a pending receipt with the reviewer-provided reason.
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
      await this.receiptReviewRepository.markRejected(
        receiptId,
        tenantId,
        dto.reason,
      );
      await this.publishReceiptRejectedEventSeam({
        receipt,
        reviewerUserId,
        reason: dto.reason,
      });
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
  };
}
