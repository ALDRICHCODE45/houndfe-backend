/**
 * HD-EXP-01a — `normalizeExpirationText` spec: NFC, C0/C1 rejection before
 * collapsing, Unicode-whitespace collapse+trim, and a strict 1..500 UTF-16
 * code-unit bound that rejects (never truncates).
 */
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import {
  EXPIRATION_TEXT_MAX_LENGTH,
  INVALID_EXPIRATION_TEXT_CODE,
  normalizeExpirationText,
} from './expiration-text';

function captureInvalid(value: unknown): InvalidArgumentError {
  try {
    normalizeExpirationText(value);
  } catch (error) {
    if (error instanceof InvalidArgumentError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected normalizeExpirationText to reject the value');
}

describe('normalizeExpirationText', () => {
  it('normalizes NFC and collapses/trims whitespace runs to one space', () => {
    expect(normalizeExpirationText('  Cafe\u0301   de   filtro  ')).toBe(
      'Caf\u00e9 de filtro',
    );
    expect(normalizeExpirationText('A\u00a0\u00a0B')).toBe('A B');
    expect(normalizeExpirationText('\u2028lote\u2029x\u3000y')).toBe(
      'lote x y',
    );
  });

  it('keeps an already-canonical value byte-identical', () => {
    expect(normalizeExpirationText('Lote 2026-A vence en agosto')).toBe(
      'Lote 2026-A vence en agosto',
    );
  });

  it.each([undefined, null, 7, true, {}, ['texto']])(
    'rejects the non-string value %p',
    (value) => {
      expect(captureInvalid(value).code).toBe(INVALID_EXPIRATION_TEXT_CODE);
    },
  );

  it.each(['', '   ', '\u00a0\u2003', '\u2028'])(
    'rejects the empty/whitespace-only value %p',
    (value) => {
      expect(captureInvalid(value).code).toBe(INVALID_EXPIRATION_TEXT_CODE);
    },
  );

  it.each([
    'line\nbreak',
    'tab\there',
    'cr\rhere',
    'nul\u0000byte',
    'del\u007f',
  ])('rejects C0/C1 controls before collapsing %p', (value) => {
    expect(captureInvalid(value).code).toBe(INVALID_EXPIRATION_TEXT_CODE);
  });

  it('accepts exactly the bound and rejects one over without truncating', () => {
    const atLimit = 'a'.repeat(EXPIRATION_TEXT_MAX_LENGTH);
    expect(normalizeExpirationText(atLimit)).toBe(atLimit);

    const overLimit = 'a'.repeat(EXPIRATION_TEXT_MAX_LENGTH + 1);
    expect(captureInvalid(overLimit).code).toBe(INVALID_EXPIRATION_TEXT_CODE);
  });

  it('measures the bound after normalization (raw padding is not counted)', () => {
    const raw = `  ${'a'.repeat(EXPIRATION_TEXT_MAX_LENGTH)}   `;
    expect(raw.length).toBeGreaterThan(EXPIRATION_TEXT_MAX_LENGTH);
    expect(normalizeExpirationText(raw)).toBe(
      'a'.repeat(EXPIRATION_TEXT_MAX_LENGTH),
    );
  });

  it('counts a surrogate pair as two UTF-16 code units', () => {
    const emoji = '\u{1F4E6}'; // 2 UTF-16 units each.
    expect(normalizeExpirationText(emoji.repeat(250))).toHaveLength(500);
    expect(captureInvalid(emoji.repeat(250) + 'a').code).toBe(
      INVALID_EXPIRATION_TEXT_CODE,
    );
  });

  it('fails value-free with a fixed code and never echoes the input', () => {
    const secret = 'PII-secret-42';
    const error = captureInvalid(`bad\n${secret}`);

    expect(error.code).toBe(INVALID_EXPIRATION_TEXT_CODE);
    expect(error.message).not.toContain(secret);
    expect(
      JSON.stringify(error, Object.getOwnPropertyNames(error)),
    ).not.toContain(secret);
  });
});
