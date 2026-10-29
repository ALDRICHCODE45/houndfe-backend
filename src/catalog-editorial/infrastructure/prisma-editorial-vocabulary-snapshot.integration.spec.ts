import type { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import {
  EditorialVocabularyUnrepresentableError,
  readEditorialVocabulary,
} from '../application/editorial-vocabulary-read';
import { hashEditorialJson } from '../domain/editorial-canonical-json';
import { EditorialVocabularyRepresentationError } from '../domain/editorial-vocabulary-representation-error';
import { PrismaEditorialVocabularySnapshot } from './prisma-editorial-vocabulary-snapshot';
import {
  executeEditorialDocker,
  withEditorialPostgres,
} from './test-support/editorial-vocabulary-postgres';

const realTest =
  process.env.RUN_EDITORIAL_POSTGRES_PROOF === '1' ? it : it.skip;

realTest(
  'preserves complete raw SQL observations in disposable PostgreSQL',
  async () => {
    let container = '';
    try {
      await withEditorialPostgres(async (db) => {
        container = db.id;
        for (const migration of [
          '20261026050000_catalog_editorial_definitions',
          '20261026060000_catalog_editorial_options',
          '20261027080000_editorial_vocabulary',
          '20261028120000_editorial_production_metadata',
        ]) {
          db.sql(
            readFileSync(
              `prisma/migrations/${migration}/migration.sql`,
              'utf8',
            ),
          );
        }
        // Execute the exact template; only wrap the result for psql JSON output.
        const bridge = jest.fn(
          (parts: TemplateStringsArray, ...values: unknown[]) => {
            expect(values).toEqual([]);
            expect(parts).toHaveLength(1);
            const statement = parts[0].trim().replace(/;$/, '');
            const row: unknown = JSON.parse(
              db.sql(`SELECT row_to_json(r) FROM (${statement}) r`),
            );
            return Promise.resolve([row]);
          },
        );
        const reader = new PrismaEditorialVocabularySnapshot({
          $queryRaw: bridge,
        } as unknown as Pick<PrismaClient, '$queryRaw'>);
        expect(await reader.read()).toEqual({
          metadata: null,
          families: [],
          definitions: [],
        });
        db.sql(`
        INSERT INTO editorial_families VALUES
          ('f2', 'z', 'Zulu', 2), ('f1', 'a', 'Alpha', 1), ('f0', 'empty', 'Empty', 1);
        INSERT INTO editorial_definitions (id, code, type, label, "numericPolicy") VALUES
          ('choice', 'a.choice', 'multi', ' Choice ', NULL),
          ('number', 'b.number', 'number', 'Number', '{"status":"resolved","magnitude":"odd","integer":false,"lower":null,"lowerInclusive":true,"upper":3,"upperInclusive":false,"extra":[null,{}]}'),
          ('text', 'c.text', 'text', 'Text', NULL);
        INSERT INTO editorial_bindings
          ("familyId", "definitionId", owner, "sortOrder", exposure, searchable, "publicationCheck", policy) VALUES
          ('f1', 'number', 'sellable', -1, 'FACET', true, 'always', '{"route":"option_cases","cases":[],"unknown":[null,{}]}'),
          ('f1', 'choice', 'product', 0, 'DETAIL', false, NULL, NULL),
          ('f2', 'choice', 'sellable', 0, 'INTERNAL', false, 'when_asserted', '{"route":"pending"}');
        INSERT INTO editorial_units VALUES
          ('u2', 'number', 'number', 'kg', 'Kilogram', 0),
          ('u1', 'number', 'number', NULL, NULL, 0);
        INSERT INTO editorial_options VALUES
          ('choice', 'multi', 'z', '2020-01-02 03:04:05.123', 'Archived', 0),
          ('choice', 'multi', 'a', NULL, 'Active', 0);
        INSERT INTO editorial_groups VALUES
          ('choice', 'multi', 'g2', 'Overlap'), ('choice', 'multi', 'g1', 'First'),
          ('choice', 'multi', 'g0', 'Empty');
        INSERT INTO editorial_group_members VALUES
          ('choice', 'g2', 'z'), ('choice', 'g1', 'z'), ('choice', 'g1', 'a');
        INSERT INTO editorial_aliases VALUES ('choice', ' Alias ', 'z');
        INSERT INTO editorial_vocabulary_metadata (id, "semanticsVersion")
          VALUES ('global', 'editorial-production-1');
      `);
        const binding = (
          familyId: string,
          owner: 'product' | 'sellable',
          publicationCheck: unknown,
          policy: unknown,
        ) => ({
          familyId,
          definitionId: 'choice',
          definitionCode: 'a.choice',
          owner,
          sortOrder: 0,
          exposure: familyId === 'f1' ? 'DETAIL' : 'INTERNAL',
          searchable: false,
          publicationCheck,
          policy,
        });
        const emptyChildren = {
          units: [],
          options: [],
          groups: [],
          aliases: [],
        };
        const expected = {
          metadata: {
            id: 'global',
            semanticsVersion: 'editorial-production-1',
          },
          families: [
            {
              id: 'f1',
              code: 'a',
              label: 'Alpha',
              minimumContractVersion: 1,
              bindings: [
                {
                  familyId: 'f1',
                  definitionId: 'number',
                  definitionCode: 'b.number',
                  owner: 'sellable',
                  sortOrder: -1,
                  exposure: 'FACET',
                  searchable: true,
                  publicationCheck: 'always',
                  policy: {
                    route: 'option_cases',
                    cases: [],
                    unknown: [null, {}],
                  },
                },
                binding('f1', 'product', null, null),
              ],
            },
            {
              id: 'f0',
              code: 'empty',
              label: 'Empty',
              minimumContractVersion: 1,
              bindings: [],
            },
            {
              id: 'f2',
              code: 'z',
              label: 'Zulu',
              minimumContractVersion: 2,
              bindings: [
                binding('f2', 'sellable', 'when_asserted', {
                  route: 'pending',
                }),
              ],
            },
          ],
          definitions: [
            {
              id: 'choice',
              code: 'a.choice',
              label: ' Choice ',
              type: 'multi',
              numericPolicy: null,
              units: [],
              options: [
                {
                  definitionId: 'choice',
                  definitionType: 'multi',
                  code: 'a',
                  label: 'Active',
                  sortOrder: 0,
                  archivedAt: null,
                },
                {
                  definitionId: 'choice',
                  definitionType: 'multi',
                  code: 'z',
                  label: 'Archived',
                  sortOrder: 0,
                  archivedAt: '2020-01-02T03:04:05.123',
                },
              ],
              groups: ['g0', 'g1', 'g2'].map((code, index) => ({
                definitionId: 'choice',
                definitionType: 'multi',
                code,
                label: ['Empty', 'First', 'Overlap'][index],
                members: (code === 'g0'
                  ? []
                  : code === 'g1'
                    ? ['a', 'z']
                    : ['z']
                ).map((optionCode) => ({
                  definitionId: 'choice',
                  groupCode: code,
                  optionCode,
                })),
              })),
              aliases: [
                { definitionId: 'choice', label: ' Alias ', optionCode: 'z' },
              ],
            },
            {
              ...emptyChildren,
              id: 'number',
              code: 'b.number',
              label: 'Number',
              type: 'number',
              numericPolicy: {
                status: 'resolved',
                magnitude: 'odd',
                integer: false,
                lower: null,
                lowerInclusive: true,
                upper: 3,
                upperInclusive: false,
                extra: [null, {}],
              },
              units: [
                {
                  id: 'u1',
                  definitionId: 'number',
                  definitionType: 'number',
                  unitCode: null,
                  label: null,
                  sortOrder: 0,
                },
                {
                  id: 'u2',
                  definitionId: 'number',
                  definitionType: 'number',
                  unitCode: 'kg',
                  label: 'Kilogram',
                  sortOrder: 0,
                },
              ],
            },
            {
              ...emptyChildren,
              id: 'text',
              code: 'c.text',
              label: 'Text',
              type: 'text',
              numericPolicy: null,
            },
          ],
        };
        expect(await reader.read()).toEqual(expected);
        // Historical simulations only: current migrations deliberately reject these writes.
        db.sql(`
        ALTER TABLE editorial_families DROP CONSTRAINT editorial_families_label_nonblank;
        ALTER TABLE editorial_units DROP CONSTRAINT editorial_units_label_null_unit;
        UPDATE editorial_families SET label = ' ' WHERE id = 'f1';
        UPDATE editorial_units SET label = 'Unpaired' WHERE id = 'u1';
        UPDATE editorial_units SET label = NULL WHERE id = 'u2';
      `);
        expected.families[0].label = ' ';
        Object.assign(expected.definitions[1].units[0], { label: 'Unpaired' });
        Object.assign(expected.definitions[1].units[1], { label: null });
        expect(await reader.read()).toEqual(expected);
        expect(bridge).toHaveBeenCalledTimes(3);
      });
    } finally {
      if (container) {
        expect(
          executeEditorialDocker([
            'ps',
            '-aq',
            '--no-trunc',
            '--filter',
            `id=${container}`,
          ]).trim(),
        ).toBe('');
        console.info(`Snapshot proof container absent: ${container}`);
      }
    }
  },
  180000,
);

realTest(
  'composes exact SQL snapshots into versioned responses without changing storage',
  async () => {
    let container = '';
    try {
      await withEditorialPostgres(async (db) => {
        container = db.id;
        for (const migration of [
          '20261026050000_catalog_editorial_definitions',
          '20261026060000_catalog_editorial_options',
          '20261027080000_editorial_vocabulary',
          '20261028120000_editorial_production_metadata',
        ]) {
          db.sql(
            readFileSync(
              `prisma/migrations/${migration}/migration.sql`,
              'utf8',
            ),
          );
        }
        const bridge = jest.fn(
          (parts: TemplateStringsArray, ...values: unknown[]) => {
            expect(values).toEqual([]);
            expect(parts).toHaveLength(1);
            const statement = parts[0].trim().replace(/;$/, '');
            const row: unknown = JSON.parse(
              db.sql(`SELECT row_to_json(r) FROM (${statement}) r`),
            );
            return Promise.resolve([row]);
          },
        );
        const reader = new PrismaEditorialVocabularySnapshot({
          $queryRaw: bridge,
        } as unknown as Pick<PrismaClient, '$queryRaw'>);
        const readOnce = async (version: 1 | 2) => {
          const before = bridge.mock.calls.length;
          try {
            return await readEditorialVocabulary(reader, version);
          } finally {
            expect(bridge.mock.calls.length - before).toBe(1);
          }
        };
        const expectUnrepresentable = async () => {
          const before = await reader.read();
          let failure: unknown;
          try {
            await readOnce(2);
          } catch (error) {
            failure = error;
          }
          expect(failure).toBeInstanceOf(
            EditorialVocabularyUnrepresentableError,
          );
          expect(failure).toMatchObject({
            message: 'EDITORIAL_VOCABULARY_UNREPRESENTABLE',
          });
          expect(
            (failure as EditorialVocabularyUnrepresentableError).cause,
          ).toBeInstanceOf(EditorialVocabularyRepresentationError);
          expect(await reader.read()).toEqual(before);
        };
        const empty = await reader.read();
        expect(empty).toEqual({
          metadata: null,
          families: [],
          definitions: [],
        });
        await expectUnrepresentable();
        expect(await readOnce(1)).toEqual({ families: [], definitions: [] });
        expect(await reader.read()).toEqual(empty);

        db.sql(`
          INSERT INTO editorial_vocabulary_metadata (id, "semanticsVersion")
            VALUES ('global', 'editorial-production-1');
          INSERT INTO editorial_families VALUES ('f', 'custom.f', ' Family ñ ', 1);
          INSERT INTO editorial_definitions (id, code, type, label, "numericPolicy")
            VALUES ('d', 'custom.d', 'single', ' Choice ñ ', NULL);
          INSERT INTO editorial_bindings
            ("familyId", "definitionId", owner, "sortOrder", exposure, searchable, "publicationCheck", policy)
            VALUES ('f', 'd', 'sellable', -2, 'DETAIL', false, 'when_asserted', '{"route":"pending"}');
          INSERT INTO editorial_options VALUES
            ('d', 'single', 'z', '2020-01-02 03:04:05.123', ' Archived ', -1),
            ('d', 'single', 'a', NULL, ' Active ', 2);
        `);
        const options = [
          { code: 'z', label: ' Archived ', sortOrder: -1, archived: true },
          { code: 'a', label: ' Active ', sortOrder: 2, archived: false },
        ];
        const binding = {
          definitionId: 'd',
          definitionCode: 'custom.d',
          owner: 'sellable',
          sortOrder: -2,
        };
        const definition = {
          id: 'd',
          code: 'custom.d',
          label: ' Choice ñ ',
          type: 'single',
          options,
        };
        const legacy = {
          families: [
            {
              id: 'f',
              code: 'custom.f',
              label: ' Family ñ ',
              bindings: [binding],
            },
          ],
          definitions: [definition],
        };
        const vocabulary = {
          semanticsVersion: 'editorial-production-1',
          families: [
            {
              id: 'f',
              code: 'custom.f',
              label: ' Family ñ ',
              bindings: [
                {
                  ...binding,
                  exposure: 'DETAIL',
                  searchable: false,
                  publicationCheck: 'when_asserted',
                  policy: { route: 'pending' },
                },
              ],
            },
          ],
          definitions: [{ ...definition, groups: [], aliases: [] }],
        };
        const beforeReads = await reader.read();
        expect(await readOnce(1)).toEqual(legacy);
        expect(await readOnce(2)).toEqual({
          contractVersion: 2,
          vocabularyRevision: `ev2-sha256-${hashEditorialJson({ contractVersion: 2, vocabulary })}`,
          vocabulary,
        });
        expect(await reader.read()).toEqual(beforeReads);

        const resolvedPolicy = {
          route: 'option_cases',
          cases: [
            {
              code: 'custom',
              when: [],
              applicability: 'applicable',
              required: false,
              allowNA: false,
              evidenceRequired: false,
              documentary: 'unresolved',
            },
          ],
        };
        // This change is an explicit test fixture write, never reader adoption.
        db.sql(
          `UPDATE editorial_bindings SET policy = '${JSON.stringify(resolvedPolicy)}'::jsonb WHERE "familyId" = 'f'`,
        );
        const beforeLegacyColumnRead = await reader.read();
        const legacyColumnResponse = await readOnce(2);
        expect(await reader.read()).toEqual(beforeLegacyColumnRead);
        expect(beforeLegacyColumnRead).toMatchObject({
          families: [{ minimumContractVersion: 1 }],
        });
        db.sql(
          `UPDATE editorial_families SET "minimumContractVersion" = 2 WHERE id = 'f'`,
        );
        const advanced = {
          ...vocabulary,
          families: [
            {
              ...vocabulary.families[0],
              bindings: [
                {
                  ...vocabulary.families[0].bindings[0],
                  policy: resolvedPolicy,
                },
              ],
            },
          ],
        };
        const beforeAdvancedRead = await reader.read();
        expect(beforeAdvancedRead).toMatchObject({
          families: [{ minimumContractVersion: 2 }],
        });
        expect(await readOnce(2)).toEqual(legacyColumnResponse);
        expect(await readOnce(2)).toEqual({
          contractVersion: 2,
          vocabularyRevision: `ev2-sha256-${hashEditorialJson({ contractVersion: 2, vocabulary: advanced })}`,
          vocabulary: advanced,
        });
        expect(await reader.read()).toEqual(beforeAdvancedRead);
      });
    } finally {
      if (container) {
        expect(
          executeEditorialDocker([
            'ps',
            '-aq',
            '--no-trunc',
            '--filter',
            `id=${container}`,
          ]).trim(),
        ).toBe('');
        console.info(`SQL-to-response proof container absent: ${container}`);
      }
    }
  },
  180000,
);
