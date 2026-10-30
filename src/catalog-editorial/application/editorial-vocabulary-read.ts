import { materializeHistoricalVocabularyResponseV2 } from '../domain/editorial-vocabulary-historical-v2';
import { EditorialVocabularyRepresentationError } from '../domain/editorial-vocabulary-representation-error';

export class EditorialVocabularyUnrepresentableError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super('EDITORIAL_VOCABULARY_UNREPRESENTABLE');
    this.cause = cause;
  }
}

export async function readEditorialVocabulary(source: {
  read(): Promise<unknown>;
}): Promise<ReturnType<typeof materializeHistoricalVocabularyResponseV2>> {
  const snapshot = await source.read();
  try {
    return materializeHistoricalVocabularyResponseV2(snapshot);
  } catch (error) {
    if (error instanceof EditorialVocabularyRepresentationError) {
      throw new EditorialVocabularyUnrepresentableError(error);
    }
    throw error;
  }
}
