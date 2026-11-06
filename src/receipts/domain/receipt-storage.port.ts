import type { Readable } from 'node:stream';

/**
 * Private object storage for receipt evidence. Objects are never public:
 * staff reads them only through permission-checked routes.
 */
export const RECEIPT_STORAGE = Symbol('RECEIPT_STORAGE');

export type ReceiptStoredObject = {
  body: Readable;
  contentLength: number | null;
};

export interface ReceiptStoragePort {
  /** @throws when the object could not be stored. */
  putPrivate(input: {
    key: string;
    bytes: Buffer;
    mimeType: string;
  }): Promise<void>;

  /** Best effort: failures are logged by the adapter, never thrown. */
  delete(key: string): Promise<void>;

  /**
   * Streams a private object. @returns null when the object does not exist.
   * @throws on any other storage failure.
   */
  getPrivate(key: string): Promise<ReceiptStoredObject | null>;

  /**
   * Deletes an object and reports failures (deleting a missing object
   * succeeds). Used by retention, which must not forget a key it could not
   * delete.
   */
  remove(key: string): Promise<void>;
}

/** Rasterizes the first page of a PDF into a PNG preview. */
export const RECEIPT_PREVIEW_RASTERIZER = Symbol('RECEIPT_PREVIEW_RASTERIZER');

export interface ReceiptPreviewRasterizer {
  /** @throws when the PDF cannot be rendered within the guards. */
  rasterizeFirstPage(
    pdf: Buffer,
  ): Promise<{ bytes: Buffer; mimeType: 'image/png' }>;
}
