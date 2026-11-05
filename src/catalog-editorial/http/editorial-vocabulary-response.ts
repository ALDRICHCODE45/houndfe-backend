import { withDefinitionDescriptions } from '../application/editorial-vocabulary-descriptions';
import { withFamilySections } from '../application/editorial-vocabulary-sections';
import {
  EditorialVocabularyUnrepresentableError,
  readEditorialVocabulary,
} from '../application/editorial-vocabulary-read';
import {
  EditorialVocabularyHeaderError,
  parseEditorialVocabularyHeaders,
} from './editorial-vocabulary-headers';

/** Response descriptor; callers must complete current auth/authority first.
 * A source that can also report definition descriptions (one observation) gets
 * them attached after the revision is computed, so they never change it.
 * Production family sections (static presentation metadata) are attached the
 * same way, after the revision.
 */
export async function createEditorialVocabularyHttpResponse(
  source: {
    read(): Promise<unknown>;
    readWithDescriptions?(): Promise<{
      snapshot: unknown;
      descriptions: ReadonlyMap<string, string>;
    }>;
  },
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
    const observed = await source.readWithDescriptions?.();
    const body = await readEditorialVocabulary(
      observed ? { read: () => Promise.resolve(observed.snapshot) } : source,
    );
    headers['Editorial-Vocabulary-Revision'] = body.vocabularyRevision;
    return {
      statusCode: 200,
      headers,
      body: withFamilySections(
        observed
          ? withDefinitionDescriptions(body, observed.descriptions)
          : body,
      ),
    };
  } catch (error) {
    return failure(
      500,
      error instanceof EditorialVocabularyUnrepresentableError
        ? 'EDITORIAL_VOCABULARY_UNREPRESENTABLE'
        : 'INTERNAL_ERROR',
    );
  }
}
