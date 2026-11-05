import type { EditorialContext } from './catalog-editorial-core';
import type { ReceiptRequestV2 } from './editorial-write-request-v2';
import type { ReceiptResultV2 } from './editorial-recorded-receipt-result-v2';

export const EDITORIAL_UNPUBLISH_WRITER = Symbol('EDITORIAL_UNPUBLISH_WRITER');

/** Trusted scope and structurally admitted unpublish intent; authority is rechecked. */
export interface EditorialUnpublishWriter {
  unpublish(
    context: EditorialContext,
    key: string,
    request: ReceiptRequestV2,
  ): Promise<ReceiptResultV2>;
}
