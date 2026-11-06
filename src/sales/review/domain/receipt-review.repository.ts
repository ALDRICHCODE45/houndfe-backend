import type { ReceiptExtracted } from '../../../receipts/domain/receipt-fields';
import type { ReceiptMismatch } from '../../../receipts/domain/receipt-mismatch';

export type ReceiptReviewStatus = 'PENDING' | 'CONFIRMED' | 'REJECTED';

/** Stored private file metadata; null for legacy `mediaUrl` rows. */
export type ReceiptReviewFile = {
  mimeType: string;
  sizeBytes: number | null;
  previewStatus: 'READY' | 'UNAVAILABLE';
  /** True once the retention job deleted the stored objects. */
  purged: boolean;
};

export type ReceiptReviewSaleSnapshot = {
  id: string;
  status: 'DRAFT' | 'CONFIRMED';
  paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT' | null;
  paidCents: number;
  debtCents: number;
  totalCents: number;
  channel: 'POS' | 'ONLINE';
  folio: string | null;
  customerName: string | null;
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
  customerReason: string | null;
  createdAt: Date;
  /** False when the chatbot did not declare an amount (declaredAmountCents 0). */
  declaredAmountProvided: boolean;
  file: ReceiptReviewFile | null;
  extracted: ReceiptExtracted | null;
  mismatch: ReceiptMismatch | null;
  sale: ReceiptReviewSaleSnapshot;
};

/** Keyset position in the tenant-wide queue (oldest first). */
export type ReceiptQueuePosition = { createdAt: Date; id: string };

export interface ReceiptReviewRepository {
  findPendingForSale(
    saleId: string,
    tenantId: string,
  ): Promise<ReceiptReviewRecord[]>;
  /** Pending receipts of every confirmed sale in the tenant, oldest first. */
  findPendingForTenant(
    tenantId: string,
    page: { limit: number; after: ReceiptQueuePosition | null },
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
  ): Promise<boolean>;
  markRejected(
    receiptId: string,
    tenantId: string,
    reason: string,
  ): Promise<boolean>;
}

export const RECEIPT_REVIEW_REPOSITORY = Symbol.for('ReceiptReviewRepository');
