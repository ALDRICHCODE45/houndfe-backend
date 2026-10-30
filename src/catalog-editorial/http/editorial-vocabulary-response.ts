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
  const headers: Record<string, string> = {
    'Cache-Control': 'no-store',
    'Editorial-Contract-Version': '2',
  };
  const failure = (statusCode: number, error: string) => ({
    statusCode,
    headers,
    body: { statusCode, error },
  });
  try {
    parseEditorialVocabularyHeaders(rawHeaders);
  } catch (error) {
    if (error instanceof EditorialVocabularyHeaderError) {
      return failure(error.statusCode, error.code);
    }
    return failure(500, 'INTERNAL_ERROR');
  }
  try {
    const body = await readEditorialVocabulary(source);
    headers['Editorial-Vocabulary-Revision'] = body.vocabularyRevision;
    return { statusCode: 200, headers, body };
  } catch (error) {
    return failure(
      500,
      error instanceof EditorialVocabularyUnrepresentableError
        ? 'EDITORIAL_VOCABULARY_UNREPRESENTABLE'
        : 'INTERNAL_ERROR',
    );
  }
}
