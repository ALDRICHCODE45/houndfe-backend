/**
 * ParseIdempotencyKeyPipe — dedicated unit spec (WU2-07 support).
 *
 * The pipe is the first guard on the bot registration idempotency flow,
 * so its branches are exercised individually here rather than only via
 * the larger controller spec. That gives a tighter feedback loop when
 * the validation rules change (length cap, trim semantics, type
 * rejection).
 */
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  INVALID_IDEMPOTENCY_KEY_CODE,
  ParseIdempotencyKeyPipe,
} from './parse-idempotency-key.pipe';
import { InvalidArgumentError } from '../../../shared/domain/domain-error';

describe('ParseIdempotencyKeyPipe', () => {
  let pipe: ParseIdempotencyKeyPipe;

  beforeEach(() => {
    pipe = new ParseIdempotencyKeyPipe();
  });

  it('returns the trimmed string when the key is valid', () => {
    expect(pipe.transform('bot-order-abc-123', { type: 'custom' })).toBe(
      'bot-order-abc-123',
    );
    expect(pipe.transform('  bot-order-trim  ', { type: 'custom' })).toBe(
      'bot-order-trim',
    );
  });

  it('throws INVALID_IDEMPOTENCY_KEY when value is missing (undefined)', () => {
    expect(() => pipe.transform(undefined, { type: 'custom' })).toThrow(
      InvalidArgumentError,
    );
    try {
      pipe.transform(undefined, { type: 'custom' });
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidArgumentError);
      expect((error as InvalidArgumentError).code).toBe(
        INVALID_IDEMPOTENCY_KEY_CODE,
      );
    }
  });

  it('throws INVALID_IDEMPOTENCY_KEY when value is null', () => {
    expect(() => pipe.transform(null, { type: 'custom' })).toThrow(
      InvalidArgumentError,
    );
  });

  it('throws INVALID_IDEMPOTENCY_KEY when value is a non-string type', () => {
    expect(() => pipe.transform(123, { type: 'custom' })).toThrow(
      InvalidArgumentError,
    );
    expect(() => pipe.transform({}, { type: 'custom' })).toThrow(
      InvalidArgumentError,
    );
    expect(() => pipe.transform([], { type: 'custom' })).toThrow(
      InvalidArgumentError,
    );
  });

  it('throws INVALID_IDEMPOTENCY_KEY when value is empty', () => {
    expect(() => pipe.transform('', { type: 'custom' })).toThrow(
      InvalidArgumentError,
    );
    try {
      pipe.transform('', { type: 'custom' });
    } catch (error) {
      expect((error as InvalidArgumentError).code).toBe(
        INVALID_IDEMPOTENCY_KEY_CODE,
      );
    }
  });

  it('throws INVALID_IDEMPOTENCY_KEY when value is whitespace-only', () => {
    expect(() => pipe.transform('   ', { type: 'custom' })).toThrow(
      InvalidArgumentError,
    );
    expect(() => pipe.transform('\t\n', { type: 'custom' })).toThrow(
      InvalidArgumentError,
    );
  });

  it('throws INVALID_IDEMPOTENCY_KEY when length exceeds the 200-char cap', () => {
    const oversized = 'a'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1);
    try {
      pipe.transform(oversized, { type: 'custom' });
      fail('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidArgumentError);
      expect((error as InvalidArgumentError).code).toBe(
        INVALID_IDEMPOTENCY_KEY_CODE,
      );
      expect((error as InvalidArgumentError).message).toMatch(
        /maximum length of 200 characters/i,
      );
    }
  });

  it('accepts a key exactly at the 200-char boundary', () => {
    const boundary = 'a'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH);
    expect(pipe.transform(boundary, { type: 'custom' })).toBe(boundary);
  });

  it('rejects a key one character over the 200-char boundary', () => {
    const over = 'a'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1);
    expect(() => pipe.transform(over, { type: 'custom' })).toThrow(
      InvalidArgumentError,
    );
  });
});
