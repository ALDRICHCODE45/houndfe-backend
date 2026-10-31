import type { EditorialContext } from './catalog-editorial-core';
import type { ReceiptRequestV2 } from './editorial-write-request-v2';
import type { ReceiptResultV2 } from './editorial-recorded-receipt-result-v2';

export const EDITORIAL_SAVE_WRITER = Symbol('EDITORIAL_SAVE_WRITER');

/** Admitted save intent and trusted scope; transaction rechecks authority. */
export interface EditorialSaveWriter {
  save(
    context: EditorialContext,
    key: string,
    request: ReceiptRequestV2,
  ): Promise<ReceiptResultV2>;
}
