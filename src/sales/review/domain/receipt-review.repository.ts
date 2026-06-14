export type ReceiptReviewStatus = 'PENDING' | 'CONFIRMED' | 'REJECTED';

export type ReceiptReviewSaleSnapshot = {
  id: string;
  status: 'DRAFT' | 'CONFIRMED';
  paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT' | null;
  paidCents: number;
  debtCents: number;
  totalCents: number;
  channel: 'POS' | 'ONLINE';
};

export type ReceiptReviewRecord = {
  id: string;
  saleId: string;
  tenantId: string;
  mediaUrl: string;
  declaredAmountCents: number;
  declaredDate: Date | null;
  declaredReference: string | null;
  status: ReceiptReviewStatus;
  confirmedByUserId: string | null;
  confirmedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
  sale: ReceiptReviewSaleSnapshot;
};

export interface ReceiptReviewRepository {
  findPendingForSale(
    saleId: string,
    tenantId: string,
  ): Promise<ReceiptReviewRecord[]>;
  findById(
    receiptId: string,
    tenantId: string,
  ): Promise<ReceiptReviewRecord | null>;
  markConfirmed(
    receiptId: string,
    tenantId: string,
    userId: string,
    timestamp: Date,
  ): Promise<void>;
  markRejected(
    receiptId: string,
    tenantId: string,
    reason: string,
  ): Promise<void>;
}

export const RECEIPT_REVIEW_REPOSITORY = Symbol.for('ReceiptReviewRepository');
