import { Prisma, PrismaClient } from '@prisma/client';
import {
  STARTER_V1,
  type VocabularySeed,
} from './editorial-vocabulary-seed.data';

type SeedClient = { $executeRaw(query: Prisma.Sql): Promise<number> };

/** Caller supplies a transaction. No deletes; omitted entries remain untouched. */
export async function seedEditorialVocabulary(
  client: SeedClient,
  data: VocabularySeed = STARTER_V1,
) {
  const { family } = data;
  await client.$executeRaw(Prisma.sql`
    INSERT INTO editorial_families (id, code, label)
    VALUES (${family.id}, ${family.code}, ${family.label})
    ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label
  `);
  // Resolve persisted ids by code: a pre-existing code may have a different id.
  for (const d of data.definitions) {
    await client.$executeRaw(Prisma.sql`
      INSERT INTO editorial_definitions (id, code, label, type)
      VALUES (${d.code}, ${d.code}, ${d.label}, ${d.type})
      ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, type = EXCLUDED.type
    `);
    await client.$executeRaw(Prisma.sql`
      INSERT INTO editorial_bindings ("familyId", "definitionId", owner, "sortOrder")
      SELECT f.id, d.id, ${d.owner}, ${d.sortOrder}
      FROM editorial_families f, editorial_definitions d
      WHERE f.code = ${family.code} AND d.code = ${d.code}
      ON CONFLICT ("familyId", "definitionId") DO UPDATE
      SET owner = EXCLUDED.owner, "sortOrder" = EXCLUDED."sortOrder"
    `);
  }
  for (const o of data.options) {
    await client.$executeRaw(Prisma.sql`
      INSERT INTO editorial_options ("definitionId", "definitionType", code, label, "sortOrder", "archivedAt")
      SELECT id, ${o.type}, ${o.code}, ${o.label}, ${o.sortOrder},
        CASE WHEN ${o.archived === true} THEN CURRENT_TIMESTAMP ELSE NULL END
      FROM editorial_definitions WHERE code = ${o.definitionCode}
      ON CONFLICT ("definitionId", code) DO UPDATE
      SET label = EXCLUDED.label, "sortOrder" = EXCLUDED."sortOrder",
        "archivedAt" = CASE WHEN ${o.archived === true}
          THEN COALESCE(editorial_options."archivedAt", EXCLUDED."archivedAt")
          ELSE editorial_options."archivedAt" END
    `);
  }
  for (const u of data.units) {
    await client.$executeRaw(Prisma.sql`
      INSERT INTO editorial_units (id, "definitionId", "definitionType", "unitCode", label, "sortOrder")
      SELECT ${u.id}, id, 'number', ${u.code}, ${u.label}, ${u.sortOrder}
      FROM editorial_definitions WHERE code = ${u.definitionCode}
      ON CONFLICT ("definitionId", "unitCode") DO UPDATE
      SET label = EXCLUDED.label, "sortOrder" = EXCLUDED."sortOrder"
    `);
  }
}

// Importing the module never connects; tests cannot execute the CLI branch.
if (require.main === module && process.env.NODE_ENV !== 'test') {
  const prisma = new PrismaClient();
  void prisma
    .$transaction((tx) => seedEditorialVocabulary(tx))
    .finally(() => prisma.$disconnect());
}
