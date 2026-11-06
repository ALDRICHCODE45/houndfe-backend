import type { ReceiptExtracted } from '../../../receipts/domain/receipt-fields';
import type { ReceiptMismatch } from '../../../receipts/domain/receipt-mismatch';
import type { ReceiptReviewStatus } from '../domain/receipt-review.repository';

/** Private file of a receipt; routes are relative to the API base URL. */
export type ReceiptReviewFileDto = {
  mimeType: string;
  sizeBytes: number | null;
  previewStatus: 'READY' | 'UNAVAILABLE';
  /** Null once the retention policy deleted the file. */
  originalUrl: string | null;
  /** Null when the preview is unavailable or the file was deleted. */
  previewUrl: string | null;
};

export type ReceiptReviewQueueItemDto = {
  id: string;
  saleId: string;
  /** '' for private uploads; use `file` instead. */
  mediaUrl: string;
  /** 0 when nothing was declared; see `declaredAmountProvided`. */
  declaredAmountCents: number;
  declaredDate: Date | null;
  declaredReference: string | null;
  status: ReceiptReviewStatus;
  salePaymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT' | null;
  salePaidCents: number;
  saleDebtCents: number;
  saleTotalCents: number;
  // ── T2 additive keys ──
  declaredAmountProvided: boolean;
  /** Null for legacy rows that only have `mediaUrl`. */
  file: ReceiptReviewFileDto | null;
  extracted: ReceiptExtracted | null;
  mismatch: ReceiptMismatch | null;
  createdAt: Date;
};

export type ReceiptReviewQueueResponseDto = ReceiptReviewQueueItemDto[];

export type TenantReceiptQueueItemDto = ReceiptReviewQueueItemDto & {
  saleFolio: string | null;
  customerName: string | null;
};

export type TenantReceiptQueuePageDto = {
  items: TenantReceiptQueueItemDto[];
  nextCursor: string | null;
};
