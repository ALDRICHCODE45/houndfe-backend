import { projectHistoricalVocabularyV1 } from '../domain/editorial-vocabulary-historical-v1';
import { materializeHistoricalVocabularyResponseV2 } from '../domain/editorial-vocabulary-historical-v2';
import { EditorialVocabularyRepresentationError } from '../domain/editorial-vocabulary-representation-error';

export class EditorialVocabularyUnrepresentableError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super('EDITORIAL_VOCABULARY_UNREPRESENTABLE');
    this.cause = cause;
  }
}

export async function readEditorialVocabulary(
  source: { read(): Promise<unknown> },
  version: 1 | 2,
): Promise<
  | ReturnType<typeof projectHistoricalVocabularyV1>
  | ReturnType<typeof materializeHistoricalVocabularyResponseV2>
> {
  if (version !== 1 && version !== 2) {
    throw new TypeError('Expected editorial vocabulary version 1 or 2');
  }
  const snapshot = await source.read();
  if (version === 1) return projectHistoricalVocabularyV1(snapshot);
  try {
    return materializeHistoricalVocabularyResponseV2(snapshot);
  } catch (error) {
    if (error instanceof EditorialVocabularyRepresentationError) {
      throw new EditorialVocabularyUnrepresentableError(error);
    }
    throw error;
  }
}
