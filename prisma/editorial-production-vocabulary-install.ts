import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { canonicalEditorialJson } from '../src/catalog-editorial/domain/editorial-canonical-json';
import { materializeStoredVocabularyV2 } from '../src/catalog-editorial/domain/editorial-vocabulary-stored-root-v2';
import { validateFullProductionVocabularyV2 } from '../src/catalog-editorial/domain/editorial-vocabulary-full-production-v2';
import { PrismaEditorialVocabularySnapshot } from '../src/catalog-editorial/infrastructure/prisma-editorial-vocabulary-snapshot';
import { readEditorialVocabulary } from '../src/catalog-editorial/application/editorial-vocabulary-read';
import { buildProductionVocabularyManifest } from './editorial-production-vocabulary.manifest';
import {
  productionVocabularyRows,
  type VocabularyStorageIdentities,
} from './editorial-production-vocabulary-rows';
import { STARTER_V1 } from './editorial-vocabulary-seed.data';

export interface VocabularyInstallResult {
  committed: boolean;
  canonicalDefinitions: number;
}
type StarterSnapshot = {
  metadata: unknown;
  families: {
    id: string;
    code: string;
    bindings: { policy: unknown; publicationCheck: unknown }[];
  }[];
  definitions: {
    id: string;
    code: string;
    type: string;
    numericPolicy: unknown;
  }[];
};
class DryRunRollback extends Error {
  constructor(readonly result: VocabularyInstallResult) {
    super('VOCABULARY_DRY_RUN_ROLLBACK');
  }
}
const fail = (): never => {
  throw new Error('VOCABULARY_INSTALL_PRECONDITION_FAILED');
};

/** Caller owns target authorization and backup; this function owns one transaction.
 * Defaults to a fully executed, validated rollback. Never retires editorial state.
 */
export async function installProductionVocabulary(
  prisma: Pick<PrismaClient, '$transaction'>,
  expectedBeforeSha256: string,
  commit = false,
): Promise<VocabularyInstallResult> {
  if (!/^[a-f0-9]{64}$/.test(expectedBeforeSha256))
    throw new Error('INVALID_VOCABULARY_BEFORE_IMAGE');
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10s'");
        await tx.$executeRawUnsafe(`LOCK TABLE editorial_families, editorial_definitions,
        editorial_bindings, editorial_options, editorial_units, editorial_groups,
        editorial_group_members, editorial_aliases, editorial_vocabulary_metadata
        IN SHARE ROW EXCLUSIVE MODE`);
        const snapshot = await new PrismaEditorialVocabularySnapshot(tx).read();
        if (
          createHash('sha256')
            .update(canonicalEditorialJson(snapshot))
            .digest('hex') !== expectedBeforeSha256
        )
          fail();
        const before = structuredClone(snapshot) as StarterSnapshot;
        if (
          before.metadata !== null ||
          before.families.length !== 1 ||
          before.families[0].id !== STARTER_V1.family.id ||
          before.families[0].code !== STARTER_V1.family.code ||
          before.definitions.length !== STARTER_V1.definitions.length
        )
          fail();
        for (const expected of STARTER_V1.definitions) {
          const matches = before.definitions.filter(
            (d) => d.code === expected.code && d.type === expected.type,
          );
          if (matches.length !== 1) fail();
        }
        const bindings = before.families[0].bindings;
        if (bindings.length !== 5) fail();
        for (const b of bindings) {
          if (b.policy !== null || b.publicationCheck !== null) fail();
          b.policy = { route: 'pending' };
          b.publicationCheck = 'when_asserted';
        }
        const numeric = before.definitions.find(
          (d) => d.code === 'starter.weight',
        );
        if (!numeric || numeric.numericPolicy !== null) return fail();
        numeric.numericPolicy = { status: 'pending' };
        const manifest = buildProductionVocabularyManifest();
        const ids: VocabularyStorageIdentities = {
          families: {},
          definitions: {},
          units: {},
        };
        for (const f of manifest.families) ids.families[f.code] = randomUUID();
        for (const d of manifest.definitions) {
          ids.definitions[d.code] = { id: randomUUID(), type: d.type };
          if ('units' in d)
            for (const u of d.units)
              ids.units[JSON.stringify([d.code, u.code])] = randomUUID();
        }
        const added = productionVocabularyRows(ids);
        validateFullProductionVocabularyV2(
          materializeStoredVocabularyV2({
            metadata: added.metadata,
            families: [...before.families, ...added.families],
            definitions: [...before.definitions, ...added.definitions],
          }),
        );
        await tx.editorialFamily.createMany({
          data: added.families.map(
            ({ id, code, label, minimumContractVersion }) => ({
              id,
              code,
              label,
              minimumContractVersion,
            }),
          ),
        });
        await tx.editorialDefinition.createMany({
          data: added.definitions.map(
            ({ id, code, label, description, type, numericPolicy }) => ({
              id,
              code,
              label,
              description,
              type,
              numericPolicy: numericPolicy ?? Prisma.DbNull,
            }),
          ),
        });
        await tx.editorialBinding.createMany({
          data: added.families.flatMap((f) =>
            f.bindings.map(
              ({
                familyId,
                definitionId,
                owner,
                sortOrder,
                exposure,
                searchable,
                publicationCheck,
                policy,
              }) => ({
                familyId,
                definitionId,
                owner,
                sortOrder,
                exposure,
                searchable,
                publicationCheck,
                policy,
              }),
            ),
          ),
        });
        await tx.editorialOption.createMany({
          data: added.definitions.flatMap((d) => d.options),
        });
        await tx.editorialUnit.createMany({
          data: added.definitions.flatMap((d) => d.units),
        });
        await tx.editorialGroup.createMany({
          data: added.definitions.flatMap((d) =>
            d.groups.map(({ definitionId, definitionType, code, label }) => ({
              definitionId,
              definitionType,
              code,
              label,
            })),
          ),
        });
        await tx.editorialGroupMember.createMany({
          data: added.definitions.flatMap((d) =>
            d.groups.flatMap((g) => g.members),
          ),
        });
        await tx.editorialAlias.createMany({
          data: added.definitions.flatMap((d) => d.aliases),
        });
        const patched = await tx.editorialBinding.updateMany({
          where: { familyId: STARTER_V1.family.id, publicationCheck: null },
          data: {
            publicationCheck: 'when_asserted',
            policy: { route: 'pending' },
          },
        });
        if (patched.count !== 5) fail();
        await tx.editorialDefinition.update({
          where: { code: 'starter.weight' },
          data: { numericPolicy: { status: 'pending' } },
        });
        await tx.editorialVocabularyMetadata.create({ data: added.metadata });
        const readback = await readEditorialVocabulary(
          new PrismaEditorialVocabularySnapshot(tx),
        );
        const admitted = validateFullProductionVocabularyV2(
          readback.vocabulary,
        );
        if (admitted.definitions.length !== 73) fail();
        const result = {
          committed: commit,
          canonicalDefinitions: added.definitions.length,
        };
        if (!commit) throw new DryRunRollback(result);
        return result;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 5000,
        timeout: 20000,
      },
    );
  } catch (error) {
    if (error instanceof DryRunRollback) return error.result;
    throw error;
  }
}
