import type { EditorialContext } from './catalog-editorial-core';
import type { ReceiptRequestV2 } from './editorial-write-request-v2';
import type { ReceiptResultV2 } from './editorial-recorded-receipt-result-v2';

export const EDITORIAL_DISCARD_WRITER = Symbol('EDITORIAL_DISCARD_WRITER');

/** Trusted scope and structurally admitted discard intent; authority is rechecked. */
export interface EditorialDiscardWriter {
  discard(
    context: EditorialContext,
    key: string,
    request: ReceiptRequestV2,
  ): Promise<ReceiptResultV2>;
}
