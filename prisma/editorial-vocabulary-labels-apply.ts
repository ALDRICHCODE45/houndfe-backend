import { PrismaClient } from '@prisma/client';
import {
  DEFINITION_LABELS,
  FAMILY_LABELS,
  UNIT_LABELS,
} from '../src/catalog-editorial/domain/editorial-production-vocabulary-labels';

type Update = (args: {
  where: { label: string } & Record<string, string>;
  data: { label: string };
}) => Promise<{ count: number }>;
interface LabelClient {
  editorialFamily: { updateMany: Update };
  editorialDefinition: { updateMany: Update };
  editorialUnit: { updateMany: Update };
}
export interface LabelApplyResult {
  families: number;
  definitions: number;
  units: number;
}

/** Labels reach already-installed vocabularies here: the installer and planner
 * preserve stored labels as customization, so only rows whose label still equals
 * their code (never edited) are updated. Idempotent; no inserts, deletes or code changes.
 */
export async function applyEditorialVocabularyLabels(
  client: LabelClient,
): Promise<LabelApplyResult> {
  const result: LabelApplyResult = { families: 0, definitions: 0, units: 0 };
  for (const [code, label] of Object.entries(FAMILY_LABELS))
    result.families += (
      await client.editorialFamily.updateMany({
        where: { code, label: code },
        data: { label },
      })
    ).count;
  for (const [code, label] of Object.entries(DEFINITION_LABELS))
    result.definitions += (
      await client.editorialDefinition.updateMany({
        where: { code, label: code },
        data: { label },
      })
    ).count;
  for (const [unitCode, label] of Object.entries(UNIT_LABELS))
    result.units += (
      await client.editorialUnit.updateMany({
        where: { unitCode, label: unitCode },
        data: { label },
      })
    ).count;
  return result;
}

// Importing the module never connects; tests cannot execute the CLI branch.
if (require.main === module && process.env.NODE_ENV !== 'test') {
  const prisma = new PrismaClient();
  void prisma
    .$transaction((tx) => applyEditorialVocabularyLabels(tx))
    .then((result) => console.log('editorial labels applied', result))
    .finally(() => prisma.$disconnect());
}
