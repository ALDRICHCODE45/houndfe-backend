import type { EditorialContext } from './catalog-editorial-core';
import type { ReadinessV2 } from './editorial-publication-readiness-v2';
import type { ReceiptResultV2 } from './editorial-recorded-receipt-result-v2';
import type { ReceiptRequestV2 } from './editorial-write-request-v2';

export const EDITORIAL_PUBLISH_WRITER = Symbol('EDITORIAL_PUBLISH_WRITER');

/** Trusted scope and structurally admitted publish intent; authority is rechecked. */
export interface EditorialPublishWriter {
  publish(
    context: EditorialContext,
    key: string,
    request: ReceiptRequestV2,
  ): Promise<ReceiptResultV2>;
}

/**
 * The locked saved Draft is not publishable. Still `400 MALFORMED`, but the body
 * carries the same `items`/`bySection` the readiness endpoint returns.
 */
export class EditorialPublicationNotReadyError extends Error {
  constructor(readonly readiness: Pick<ReadinessV2, 'items' | 'bySection'>) {
    super('MALFORMED');
  }
}
