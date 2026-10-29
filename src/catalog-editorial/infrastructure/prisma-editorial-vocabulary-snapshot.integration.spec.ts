import type { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
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
