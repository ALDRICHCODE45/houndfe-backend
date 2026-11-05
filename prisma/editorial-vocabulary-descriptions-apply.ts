import { PrismaClient } from '@prisma/client';
import {
  DEFINITION_DESCRIPTIONS,
  SUPERSEDED_DEFINITION_DESCRIPTIONS,
} from '../src/catalog-editorial/domain/editorial-production-vocabulary-descriptions';

type Update = (args: {
  where: { code: string; description: string | null };
  data: { description: string };
}) => Promise<{ count: number }>;
interface DescriptionClient {
  editorialDefinition: { updateMany: Update };
}
export interface DescriptionApplyResult {
  definitions: number;
}

/** Descriptions reach already-installed vocabularies here: the installer only writes
 * them for fresh installs. Only definitions whose description is still NULL are
 * updated, so a customized description is never overwritten. Idempotent; no inserts,
 * deletes or changes to any other column, and starter rows (outside the map) are
 * untouched. A row still holding a superseded shipped text is also moved to the
 * current text; any other filled row is left as is.
 */
export async function applyEditorialVocabularyDescriptions(
  client: DescriptionClient,
): Promise<DescriptionApplyResult> {
  const result: DescriptionApplyResult = { definitions: 0 };
  for (const [code, description] of Object.entries(DEFINITION_DESCRIPTIONS)) {
    const previous =
      SUPERSEDED_DEFINITION_DESCRIPTIONS[
        code as keyof typeof SUPERSEDED_DEFINITION_DESCRIPTIONS
      ] ?? [];
    for (const current of [null, ...previous])
      result.definitions += (
        await client.editorialDefinition.updateMany({
          where: { code, description: current },
          data: { description },
        })
      ).count;
  }
  return result;
}

// Importing the module never connects; tests cannot execute the CLI branch.
if (require.main === module && process.env.NODE_ENV !== 'test') {
  const prisma = new PrismaClient();
  void prisma
    .$transaction((tx) => applyEditorialVocabularyDescriptions(tx))
    .then((result) => console.log('editorial descriptions applied', result))
    .finally(() => prisma.$disconnect());
}
