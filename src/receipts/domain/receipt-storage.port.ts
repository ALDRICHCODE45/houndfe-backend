/**
 * Private object storage for receipt evidence. Objects are never public:
 * staff reads them only through permission-checked routes (T2).
 */
export const RECEIPT_STORAGE = Symbol('RECEIPT_STORAGE');

export interface ReceiptStoragePort {
  /** @throws when the object could not be stored. */
  putPrivate(input: {
    key: string;
    bytes: Buffer;
    mimeType: string;
  }): Promise<void>;

  /** Best effort: failures are logged by the adapter, never thrown. */
  delete(key: string): Promise<void>;
}

/** Rasterizes the first page of a PDF into a PNG preview. */
export const RECEIPT_PREVIEW_RASTERIZER = Symbol('RECEIPT_PREVIEW_RASTERIZER');

export interface ReceiptPreviewRasterizer {
  /** @throws when the PDF cannot be rendered within the guards. */
  rasterizeFirstPage(
    pdf: Buffer,
  ): Promise<{ bytes: Buffer; mimeType: 'image/png' }>;
}
