import type { EditorialContext } from './catalog-editorial-core';
import type { ReceiptRequestV2 } from './editorial-write-request-v2';
import type { ReceiptResultV2 } from './editorial-recorded-receipt-result-v2';

export const EDITORIAL_INITIALIZE_WRITER = Symbol(
  'EDITORIAL_INITIALIZE_WRITER',
);

/** Admitted initialize intent and trusted scope; transaction rechecks authority. */
export interface EditorialInitializeWriter {
  initialize(
    context: EditorialContext,
    key: string,
    request: ReceiptRequestV2,
  ): Promise<ReceiptResultV2>;
}
