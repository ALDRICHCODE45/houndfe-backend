import {
  RECEIPT_MAX_BYTES,
  assertReceiptFile,
  detectReceiptMimeType,
} from './receipt-file';
import { ReceiptUploadError } from './receipt-upload.errors';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ\n', 'latin1');

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof ReceiptUploadError) return error.code;
    throw error;
  }
  return undefined;
}

describe('detectReceiptMimeType', () => {
  it.each([
    ['JPEG', JPEG, 'image/jpeg'],
    ['PNG', PNG, 'image/png'],
    ['PDF', PDF, 'application/pdf'],
  ])('detects %s from its magic bytes', (_label, bytes, mime) => {
    expect(detectReceiptMimeType(bytes)).toBe(mime);
  });

  it.each([
    ['GIF', Buffer.from('GIF89a......')],
    ['WebP', Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')],
    ['HTML', Buffer.from('<html><body>%PDF-</body></html>')],
    ['truncated PNG', PNG.subarray(0, 7)],
    ['truncated JPEG', JPEG.subarray(0, 2)],
    ['PDF marker not at offset 0', Buffer.from(' %PDF-1.4')],
    ['empty', Buffer.alloc(0)],
  ])('rejects %s', (_label, bytes) => {
    expect(detectReceiptMimeType(bytes)).toBeNull();
  });
});

describe('assertReceiptFile', () => {
  it('returns the detected MIME and ignores the declared one', () => {
    expect(assertReceiptFile(PNG)).toEqual({
      mimeType: 'image/png',
      sizeBytes: PNG.length,
    });
  });

  it('rejects a missing or empty file with RECEIPT_FILE_REQUIRED', () => {
    expect(codeOf(() => assertReceiptFile(undefined))).toBe(
      'RECEIPT_FILE_REQUIRED',
    );
    expect(codeOf(() => assertReceiptFile(Buffer.alloc(0)))).toBe(
      'RECEIPT_FILE_REQUIRED',
    );
  });

  it('rejects files over 10 MB with RECEIPT_FILE_TOO_LARGE (413)', () => {
    expect(RECEIPT_MAX_BYTES).toBe(10 * 1024 * 1024);
    const big = Buffer.concat([PDF, Buffer.alloc(RECEIPT_MAX_BYTES)]);
    let caught: unknown;
    try {
      assertReceiptFile(big);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReceiptUploadError);
    expect((caught as ReceiptUploadError).code).toBe('RECEIPT_FILE_TOO_LARGE');
    expect((caught as ReceiptUploadError).httpStatus).toBe(413);
  });

  it('accepts a file of exactly 10 MB', () => {
    const exact = Buffer.alloc(RECEIPT_MAX_BYTES);
    PDF.copy(exact);
    expect(assertReceiptFile(exact).sizeBytes).toBe(RECEIPT_MAX_BYTES);
  });

  it('rejects unknown content with RECEIPT_FILE_TYPE_NOT_ALLOWED (415)', () => {
    let caught: unknown;
    try {
      assertReceiptFile(Buffer.from('GIF89a......'));
    } catch (error) {
      caught = error;
    }
    expect((caught as ReceiptUploadError).code).toBe(
      'RECEIPT_FILE_TYPE_NOT_ALLOWED',
    );
    expect((caught as ReceiptUploadError).httpStatus).toBe(415);
  });
});
