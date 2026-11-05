import type { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readEditorialVocabulary } from '../application/editorial-vocabulary-read';
import {
  canonicalEditorialJson,
  hashEditorialJson,
} from '../domain/editorial-canonical-json';
import { createEditorialVocabularyHttpResponse } from '../http/editorial-vocabulary-response';
import { PrismaEditorialVocabularySnapshot } from './prisma-editorial-vocabulary-snapshot';
import {
  executeEditorialDocker,
  withEditorialPostgres,
} from './test-support/editorial-vocabulary-postgres';

const realTest =
  process.env.RUN_EDITORIAL_POSTGRES_PROOF === '1' ? it : it.skip;
const before = [
  '20261026050000_catalog_editorial_definitions',
  '20261026060000_catalog_editorial_options',
  '20261027080000_editorial_vocabulary',
  '20261028120000_editorial_production_metadata',
];
const migration = (name: string) =>
  readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8');
const sha256 = (value: unknown) =>
  createHash('sha256').update(canonicalEditorialJson(value)).digest('hex');

realTest(
  'description is display help: adding the column and filling it moves no digest, revision or install before-image',
  async () => {
    let container = '';
    try {
      await withEditorialPostgres(async (db) => {
        container = db.id;
        for (const name of before) db.sql(migration(name));
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

        db.sql(`
          INSERT INTO editorial_vocabulary_metadata (id, "semanticsVersion")
            VALUES ('global', 'editorial-production-1');
          INSERT INTO editorial_families VALUES ('f', 'custom.f', ' Family ñ ', 1);
          INSERT INTO editorial_definitions (id, code, type, label, "numericPolicy") VALUES
            ('d', 'custom.d', 'single', ' Choice ñ ', NULL),
            ('t', 'custom.t', 'text', 'Text', NULL);
          INSERT INTO editorial_bindings
            ("familyId", "definitionId", owner, "sortOrder", exposure, searchable, "publicationCheck", policy)
            VALUES ('f', 'd', 'sellable', -2, 'DETAIL', false, 'when_asserted', '{"route":"pending"}');
          INSERT INTO editorial_options VALUES ('d', 'single', 'a', NULL, ' Active ', 2);
        `);

        // 1. Raw definition rows as they existed BEFORE the migration: the install
        //    before-image hashes exactly this shape (plus child arrays).
        const oldRows: unknown = JSON.parse(
          db
            .sql(
              `SELECT jsonb_agg(to_jsonb(d) ORDER BY d.code) FROM editorial_definitions d`,
            )
            .trim(),
        );

        // 2. The additive migration alone.
        db.sql(migration('20261104030000_editorial_definition_description'));
        expect(
          db
            .sql(
              `SELECT is_nullable, character_maximum_length, column_default
               FROM information_schema.columns
               WHERE table_name = 'editorial_definitions' AND column_name = 'description'`,
            )
            .trim(),
        ).toBe('YES|200|');
        const rawBefore = (await reader.read()) as {
          definitions: Record<string, unknown>[];
        };
        const withoutChildren = (rows: Record<string, unknown>[]) =>
          rows.map(
            ({ units, options, groups, aliases, ...row }) => (
              void [units, options, groups, aliases],
              row
            ),
          );
        // Byte-for-byte the pre-migration rows: the new column is not in the image.
        expect(withoutChildren(rawBefore.definitions)).toEqual(oldRows);
        const imageBefore = sha256(rawBefore);
        const revisionBefore = (await readEditorialVocabulary(reader))
          .vocabularyRevision;

        // 3. Filling descriptions moves nothing that is hashed.
        db.sql(
          `UPDATE editorial_definitions SET description = 'Ayuda para el usuario ñ.' WHERE code = 'custom.d'`,
        );
        const rawAfter = await reader.read();
        expect(rawAfter).toEqual(rawBefore);
        expect(sha256(rawAfter)).toBe(imageBefore);
        expect(JSON.stringify(rawAfter)).not.toContain('description');
        const read = await readEditorialVocabulary(reader);
        expect(read.vocabularyRevision).toBe(revisionBefore);
        expect(read.vocabularyRevision).toBe(
          `ev2-sha256-${hashEditorialJson({ contractVersion: 2, vocabulary: read.vocabulary })}`,
        );

        // 4. The HTTP projection exposes it, omitting the key where it is NULL.
        const calls = bridge.mock.calls.length;
        const response = await createEditorialVocabularyHttpResponse(
          reader,
          [],
        );
        expect(bridge.mock.calls.length - calls).toBe(1);
        expect(response.statusCode).toBe(200);
        expect(response.headers['Editorial-Vocabulary-Revision']).toBe(
          revisionBefore,
        );
        const defs = (
          response.body as {
            vocabulary: { definitions: Record<string, unknown>[] };
          }
        ).vocabulary.definitions;
        expect(defs.map((d) => [d.code, d.description])).toEqual([
          ['custom.d', 'Ayuda para el usuario ñ.'],
          ['custom.t', undefined],
        ]);
        expect(defs[1]).not.toHaveProperty('description');

        // 5. The column enforces its own bound; the database is the source of truth.
        expect(() =>
          db.sql(
            `UPDATE editorial_definitions SET description = '${'x'.repeat(201)}' WHERE code = 'custom.t'`,
          ),
        ).toThrow();
        db.sql(
          `UPDATE editorial_definitions SET description = '${'x'.repeat(200)}' WHERE code = 'custom.t'`,
        );
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
      }
    }
  },
  180000,
);
