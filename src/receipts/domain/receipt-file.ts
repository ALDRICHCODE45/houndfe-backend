import { ReceiptUploadError } from './receipt-upload.errors';

export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

export type ReceiptMimeType = 'image/jpeg' | 'image/png' | 'application/pdf';

const SIGNATURES: ReadonlyArray<{ mime: ReceiptMimeType; bytes: number[] }> = [
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  {
    mime: 'image/png',
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  // "%PDF-"
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
];

/** The MIME is decided by the leading bytes only; the declared type is ignored. */
export function detectReceiptMimeType(bytes: Buffer): ReceiptMimeType | null {
  for (const signature of SIGNATURES) {
    if (
      bytes.length >= signature.bytes.length &&
      signature.bytes.every((byte, index) => bytes[index] === byte)
    ) {
      return signature.mime;
    }
  }
  return null;
}

export function assertReceiptFile(bytes: Buffer | undefined): {
  mimeType: ReceiptMimeType;
  sizeBytes: number;
} {
  if (!bytes || bytes.length === 0) {
    throw new ReceiptUploadError(
      'RECEIPT_FILE_REQUIRED',
      'A non-empty receipt file is required in the "file" field',
    );
  }
  if (bytes.length > RECEIPT_MAX_BYTES) {
    throw new ReceiptUploadError(
      'RECEIPT_FILE_TOO_LARGE',
      'Receipt file exceeds the 10 MB limit',
    );
  }
  const mimeType = detectReceiptMimeType(bytes);
  if (!mimeType) {
    throw new ReceiptUploadError(
      'RECEIPT_FILE_TYPE_NOT_ALLOWED',
      'Receipt file must be a JPEG, PNG or PDF',
    );
  }
  return { mimeType, sizeBytes: bytes.length };
}
