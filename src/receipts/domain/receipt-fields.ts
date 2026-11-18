import { ReceiptUploadError } from './receipt-upload.errors';

/** Chatbot vision prefill. Review hint only; it never decides a payment. */
export type ReceiptExtracted = {
  amountCents?: number;
  date?: string;
  reference?: string;
  bank?: string;
  confidence?: number;
  /** Destination (N18): shown to staff only; the bank never decides. */
  destinationBank?: string;
  destinationName?: string;
  /** Last 4 digits of the destination CLABE/account/card, as printed. */
  destinationAccountLast4?: string;
  originName?: string;
};

export type ReceiptUploadFields = {
  declaredAmountCents: number | null;
  declaredDate: Date | null;
  declaredReference: string | null;
  extracted: ReceiptExtracted | null;
};

const ALLOWED_FIELDS = new Set([
  'declaredAmountCents',
  'declaredDate',
  'declaredReference',
  'extracted',
]);
const ALLOWED_EXTRACTED = new Set([
  'amountCents',
  'date',
  'reference',
  'bank',
  'confidence',
  'destinationBank',
  'destinationName',
  'destinationAccountLast4',
  'originName',
]);
const EXTRACTED_MAX_CHARS = 4096;
const REFERENCE_MAX_CHARS = 120;
const BANK_MAX_CHARS = 80;
const NAME_MAX_CHARS = 120;
/** Max length per free-text extracted key (`date` is checked as ISO). */
const EXTRACTED_TEXT_MAX: Record<string, number> = {
  date: REFERENCE_MAX_CHARS,
  reference: REFERENCE_MAX_CHARS,
  bank: BANK_MAX_CHARS,
  destinationBank: BANK_MAX_CHARS,
  destinationName: NAME_MAX_CHARS,
  originName: NAME_MAX_CHARS,
};
const LAST4 = /^\d{4}$/;
// Date-only or full ISO-8601 timestamp; `Date.parse` alone accepts too much.
const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function invalidField(message: string): never {
  throw new ReceiptUploadError('INVALID_RECEIPT_FIELDS', message);
}

function invalidExtracted(message: string): never {
  throw new ReceiptUploadError('INVALID_RECEIPT_EXTRACTED', message);
}

function isIsoDate(value: string): boolean {
  return ISO_DATE.test(value) && !Number.isNaN(Date.parse(value));
}

function isPositiveCents(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

/** Multipart text value: absent or blank means "not provided". */
function text(raw: Record<string, unknown>, name: string): string | null {
  const value = raw[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string')
    invalidField(`${name} must be a single text value`);
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function parseExtracted(source: string): ReceiptExtracted {
  if (source.length > EXTRACTED_MAX_CHARS) {
    invalidExtracted('extracted is too large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    invalidExtracted('extracted must be a JSON object');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    invalidExtracted('extracted must be a JSON object');
  }
  const input = parsed as Record<string, unknown>;
  const extracted: ReceiptExtracted = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_EXTRACTED.has(key)) {
      invalidExtracted(`extracted.${key} is not allowed`);
    }
    if (key === 'amountCents') {
      if (!isPositiveCents(value)) {
        invalidExtracted('extracted.amountCents must be an integer >= 1');
      }
      extracted.amountCents = value;
    } else if (key === 'confidence') {
      if (typeof value !== 'number' || !(value >= 0 && value <= 1)) {
        invalidExtracted('extracted.confidence must be a number in [0, 1]');
      }
      extracted.confidence = value;
    } else if (key === 'destinationAccountLast4') {
      const trimmed = typeof value === 'string' ? value.trim() : '';
      if (!LAST4.test(trimmed)) {
        invalidExtracted(
          'extracted.destinationAccountLast4 must be a string of exactly 4 digits',
        );
      }
      extracted.destinationAccountLast4 = trimmed;
    } else {
      const max = EXTRACTED_TEXT_MAX[key];
      const trimmed = typeof value === 'string' ? value.trim() : '';
      if (trimmed.length === 0 || trimmed.length > max) {
        invalidExtracted(`extracted.${key} must be a non-empty string`);
      }
      if (key === 'date' && !isIsoDate(trimmed)) {
        invalidExtracted('extracted.date must be an ISO-8601 date');
      }
      extracted[
        key as
          | 'date'
          | 'reference'
          | 'bank'
          | 'destinationBank'
          | 'destinationName'
          | 'originName'
      ] = trimmed;
    }
  }
  return extracted;
}

/**
 * Strictly parses the multipart text fields of a receipt upload. Every field
 * is optional; unknown or repeated fields are rejected.
 */
export function parseReceiptUploadFields(raw: unknown): ReceiptUploadFields {
  const body = (raw ?? {}) as Record<string, unknown>;
  if (typeof body !== 'object' || Array.isArray(body)) {
    invalidField('Receipt fields must be multipart text values');
  }
  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(key)) invalidField(`${key} is not allowed`);
  }

  const amount = text(body, 'declaredAmountCents');
  let declaredAmountCents: number | null = null;
  if (amount !== null) {
    if (!/^\d+$/.test(amount) || !isPositiveCents(Number(amount))) {
      invalidField('declaredAmountCents must be an integer >= 1');
    }
    declaredAmountCents = Number(amount);
  }

  const date = text(body, 'declaredDate');
  if (date !== null && !isIsoDate(date)) {
    invalidField('declaredDate must be an ISO-8601 date');
  }

  const declaredReference = text(body, 'declaredReference');
  if (
    declaredReference !== null &&
    declaredReference.length > REFERENCE_MAX_CHARS
  ) {
    invalidField(`declaredReference exceeds ${REFERENCE_MAX_CHARS} characters`);
  }

  const extractedSource = text(body, 'extracted');
  return {
    declaredAmountCents,
    declaredDate: date === null ? null : new Date(date),
    declaredReference,
    extracted:
      extractedSource === null ? null : parseExtracted(extractedSource),
  };
}
