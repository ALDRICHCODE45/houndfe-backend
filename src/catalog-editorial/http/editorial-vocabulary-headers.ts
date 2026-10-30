export class EditorialVocabularyHeaderError extends Error {
  readonly code = 'MALFORMED';
  readonly statusCode = 400;

  constructor() {
    super('MALFORMED');
  }
}

const prohibitedHeaders = new Set([
  'editorial-contract-version',
  'editorial-vocabulary-revision',
  'editorial-adoption',
  'editorial-care-confirmation',
  'idempotency-key',
]);

/** Dormant vocabulary-GET admission over framework-parsed raw name/value pairs. */
export function parseEditorialVocabularyHeaders(
  rawHeaders: readonly string[],
): void {
  if (!Array.isArray(rawHeaders as unknown) || rawHeaders.length % 2 !== 0) {
    throw new TypeError('Expected raw header string pairs');
  }
  for (const item of rawHeaders) {
    if (typeof item !== 'string') {
      throw new TypeError('Expected raw header string pairs');
    }
  }

  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (prohibitedHeaders.has(rawHeaders[index].toLowerCase())) {
      throw new EditorialVocabularyHeaderError();
    }
  }
}
