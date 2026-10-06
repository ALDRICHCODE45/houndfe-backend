/**
 * HD-EXP-01a — pure operator `expirationText` normalization.
 *
 * Approved design (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`.
 * Fixed order: require string; NFC; reject C0/C1 (tab/newline/DEL) BEFORE any
 * collapsing; collapse remaining Unicode whitespace runs to one ASCII space and
 * trim; require 1..500 UTF-16 code units (`String.length`) AFTER normalization,
 * rejecting (never truncating) a longer value. Failures are a value-free
 * `InvalidArgumentError` with a single stable code, ready for a later
 * sanitized filter mapping. No DB/route/schema concern.
 */
import { InvalidArgumentError } from '../../shared/domain/domain-error';

/** Maximum normalized `expirationText` length in UTF-16 code units. */
export const EXPIRATION_TEXT_MAX_LENGTH = 500;

/** Stable domain code for every `expirationText` validation failure. */
export const INVALID_EXPIRATION_TEXT_CODE = 'INVALID_EXPIRATION_TEXT';

/** Runs of Unicode whitespace (spaces, NBSP, line/paragraph separators, ...). */
const WHITESPACE_RUN = /\s+/gu;

/** Throw a value-free validation error: never echo the raw input. */
function invalid(message: string): never {
  throw new InvalidArgumentError(message, INVALID_EXPIRATION_TEXT_CODE);
}

/** True when the string contains a C0, DEL or C1 control character. */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/**
 * Validate and normalize operator-provided `expirationText`. Pure and
 * non-mutating; every failure is the same fixed, value-free error.
 */
export function normalizeExpirationText(value: unknown): string {
  if (typeof value !== 'string') {
    invalid('expirationText must be a string');
  }

  const decomposed = value.normalize('NFC');
  if (hasControlCharacter(decomposed)) {
    invalid('expirationText must not contain control characters');
  }

  const collapsed = decomposed.replace(WHITESPACE_RUN, ' ').trim();
  if (collapsed.length === 0) {
    invalid('expirationText must be a non-empty string');
  }
  if (collapsed.length > EXPIRATION_TEXT_MAX_LENGTH) {
    invalid(
      `expirationText exceeds the maximum length of ${EXPIRATION_TEXT_MAX_LENGTH} characters`,
    );
  }

  return collapsed;
}
