import { parseReceiptUploadFields } from './receipt-fields';
import { ReceiptUploadError } from './receipt-upload.errors';

function rejectCode(raw: unknown): string {
  try {
    parseReceiptUploadFields(raw);
  } catch (error) {
    if (error instanceof ReceiptUploadError) return error.code;
    throw error;
  }
  throw new Error('expected rejection');
}

describe('parseReceiptUploadFields', () => {
  it('accepts an empty body: every field is optional', () => {
    expect(parseReceiptUploadFields({})).toEqual({
      declaredAmountCents: null,
      declaredDate: null,
      declaredReference: null,
      extracted: null,
    });
    expect(parseReceiptUploadFields(undefined)).toEqual(
      parseReceiptUploadFields({}),
    );
  });

  it('parses multipart text fields', () => {
    const parsed = parseReceiptUploadFields({
      declaredAmountCents: '15000',
      declaredDate: '2026-11-05',
      declaredReference: '  REF-123  ',
      extracted: JSON.stringify({
        amountCents: 15000,
        date: '2026-11-05T10:00:00Z',
        reference: 'REF-123',
        bank: 'BBVA',
        confidence: 0.92,
      }),
    });
    expect(parsed).toEqual({
      declaredAmountCents: 15000,
      declaredDate: new Date('2026-11-05'),
      declaredReference: 'REF-123',
      extracted: {
        amountCents: 15000,
        date: '2026-11-05T10:00:00Z',
        reference: 'REF-123',
        bank: 'BBVA',
        confidence: 0.92,
      },
    });
  });

  it('treats empty multipart strings as absent', () => {
    expect(
      parseReceiptUploadFields({
        declaredAmountCents: '',
        declaredDate: '',
        declaredReference: '   ',
        extracted: '',
      }),
    ).toEqual(parseReceiptUploadFields({}));
  });

  it('accepts a partial extracted block', () => {
    expect(
      parseReceiptUploadFields({ extracted: '{"confidence":0}' }).extracted,
    ).toEqual({ confidence: 0 });
  });

  it.each([
    ['zero', '0'],
    ['negative', '-5'],
    ['decimal', '10.5'],
    ['exponent', '1e3'],
    ['text', 'abc'],
    ['unsafe', '9007199254740993'],
    ['padded sign', '+100'],
  ])('rejects a %s declaredAmountCents', (_label, value) => {
    expect(rejectCode({ declaredAmountCents: value })).toBe(
      'INVALID_RECEIPT_FIELDS',
    );
  });

  it('rejects an invalid declaredDate and an oversized reference', () => {
    expect(rejectCode({ declaredDate: 'yesterday' })).toBe(
      'INVALID_RECEIPT_FIELDS',
    );
    expect(rejectCode({ declaredReference: 'x'.repeat(121) })).toBe(
      'INVALID_RECEIPT_FIELDS',
    );
  });

  it('rejects unknown and repeated fields', () => {
    expect(rejectCode({ amount: '1' })).toBe('INVALID_RECEIPT_FIELDS');
    expect(rejectCode({ declaredAmountCents: ['1', '2'] })).toBe(
      'INVALID_RECEIPT_FIELDS',
    );
  });

  it.each([
    ['not JSON', '{amountCents:1'],
    ['an array', '[]'],
    ['null', 'null'],
    ['an unknown key', '{"total":1}'],
    ['a string amount', '{"amountCents":"100"}'],
    ['a zero amount', '{"amountCents":0}'],
    ['a fractional amount', '{"amountCents":1.5}'],
    ['confidence above 1', '{"confidence":1.01}'],
    ['negative confidence', '{"confidence":-0.1}'],
    ['a non-ISO date', '{"date":"05/11/2026"}'],
    ['an empty reference', '{"reference":"  "}'],
    ['a long bank', `{"bank":"${'b'.repeat(81)}"}`],
    ['a null value', '{"bank":null}'],
    ['an oversized payload', `{"reference":"${'r'.repeat(5000)}"}`],
  ])('rejects extracted with %s', (_label, value) => {
    expect(rejectCode({ extracted: value })).toBe('INVALID_RECEIPT_EXTRACTED');
  });
});
