/**
 * Barrel export for the cash-register closing PDF surface (T5).
 *
 * The parent module wiring imports these names:
 *   - `CashClosingPdfService`      (provider, needs `CASH_APPLICATION`)
 *   - `CashClosingPdfController`   (`GET /cash-closings/:id/pdf`)
 *   - `CashClosingA4Document`      (template, for direct render tests)
 *   - `parseCashClosingReceipt` / `CashClosingSnapshotParseError`
 *   - `buildCashClosingPdfFilename`
 */
export type {
  CashClosingPdfDocumentProps,
  CashClosingReceipt,
  CashClosingReceiptSnapshot,
  CashHandoverTotals,
} from './cash-closing-receipt.types';
export {
  CASH_CLOSING_HANDOVERS_FIRST_PAGE,
  CASH_CLOSING_HANDOVERS_PAGE,
} from './cash-closing-receipt.types';
export {
  CASH_CLOSING_SNAPSHOT_INVALID,
  CashClosingSnapshotParseError,
  parseCashClosingReceipt,
} from './cash-closing-receipt.parser';
export {
  CashClosingA4Document,
  declarationVsExpectedCents,
  paginateCashClosingHandovers,
  summarizeCashHandovers,
  verificationVsDeclarationCents,
} from './cash-closing-a4.document';
export { CashClosingPdfService } from './cash-closing-pdf.service';
export type { CashClosingPdfResult } from './cash-closing-pdf.service';
export {
  CashClosingPdfController,
  buildCashClosingPdfFilename,
} from './cash-closing-pdf.controller';
