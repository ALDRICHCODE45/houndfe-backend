export class EditorialVocabularyHeaderError extends Error {
  constructor(
    ...[code, statusCode, normalizedVersion]:
      | ['UNSUPPORTED_EDITORIAL_CONTRACT', 406, undefined]
      | ['MALFORMED', 400, 2]
  ) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
    this.normalizedVersion = normalizedVersion;
  }

  readonly code: 'UNSUPPORTED_EDITORIAL_CONTRACT' | 'MALFORMED';
  readonly statusCode: 400 | 406;
  readonly normalizedVersion: 1 | 2 | undefined;
}

const prohibitedHeaders = new Set([
  'editorial-vocabulary-revision',
  'editorial-adoption',
  'editorial-care-confirmation',
  'idempotency-key',
]);

/** Dormant vocabulary-GET admission over framework-parsed raw name/value pairs. */
export function parseEditorialVocabularyHeaders(
  rawHeaders: readonly string[],
): 1 | 2 {
  if (!Array.isArray(rawHeaders as unknown) || rawHeaders.length % 2 !== 0) {
    throw new TypeError('Expected raw header string pairs');
  }
  for (const item of rawHeaders) {
    if (typeof item !== 'string') {
      throw new TypeError('Expected raw header string pairs');
    }
  }

  let version: 1 | 2 = 1;
  let seenVersion = false;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index].toLowerCase() !== 'editorial-contract-version')
      continue;
    const value = rawHeaders[index + 1];
    if (seenVersion || (value !== '1' && value !== '2')) {
      throw new EditorialVocabularyHeaderError(
        'UNSUPPORTED_EDITORIAL_CONTRACT',
        406,
        undefined,
      );
    }
    seenVersion = true;
    version = value === '2' ? 2 : 1;
  }
  if (version === 2) {
    for (let index = 0; index < rawHeaders.length; index += 2) {
      if (prohibitedHeaders.has(rawHeaders[index].toLowerCase())) {
        throw new EditorialVocabularyHeaderError('MALFORMED', 400, 2);
      }
    }
  }
  return version;
}
