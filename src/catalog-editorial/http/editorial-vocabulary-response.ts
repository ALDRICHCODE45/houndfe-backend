import {
  EditorialVocabularyUnrepresentableError,
  readEditorialVocabulary,
} from '../application/editorial-vocabulary-read';
import {
  EditorialVocabularyHeaderError,
  parseEditorialVocabularyHeaders,
} from './editorial-vocabulary-headers';

/** Dormant descriptor only; callers must complete current auth/authority first. */
export async function createEditorialVocabularyHttpResponse(
  source: { read(): Promise<unknown> },
  rawHeaders: readonly string[],
) {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  const failure = (statusCode: number, error: string) => ({
    statusCode,
    headers,
    body: { statusCode, error },
  });
  let version: 1 | 2;
  try {
    version = parseEditorialVocabularyHeaders(rawHeaders);
  } catch (error) {
    if (error instanceof EditorialVocabularyHeaderError) {
      if (error.normalizedVersion !== undefined) {
        headers['Editorial-Contract-Version'] = String(error.normalizedVersion);
      }
      return failure(error.statusCode, error.code);
    }
    return failure(500, 'INTERNAL_ERROR');
  }
  headers['Editorial-Contract-Version'] = String(version);
  try {
    const body = await readEditorialVocabulary(source, version);
    if ('vocabularyRevision' in body) {
      headers['Editorial-Vocabulary-Revision'] = body.vocabularyRevision;
    }
    return { statusCode: 200, headers, body };
  } catch (error) {
    return failure(
      500,
      version === 2 && error instanceof EditorialVocabularyUnrepresentableError
        ? 'EDITORIAL_VOCABULARY_UNREPRESENTABLE'
        : 'INTERNAL_ERROR',
    );
  }
}
