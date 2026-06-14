import type { ReceiptReviewStatus } from '../domain/receipt-review.repository';

export type ReceiptReviewQueueItemDto = {
  id: string;
  saleId: string;
  mediaUrl: string;
  declaredAmountCents: number;
  declaredDate: Date | null;
  declaredReference: string | null;
  status: ReceiptReviewStatus;
  salePaymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT' | null;
  salePaidCents: number;
  saleDebtCents: number;
  saleTotalCents: number;
};

export type ReceiptReviewQueueResponseDto = ReceiptReviewQueueItemDto[];
