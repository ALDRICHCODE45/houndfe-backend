#!/usr/bin/env bash
# Explicit, disposable PostgreSQL proof; never reads DATABASE_URL or mounts host data.
set -euo pipefail
cd "$(dirname "$0")"
container="houndfe-editorial-metadata-$$"
started=false
cleanup() { if "$started"; then docker rm -f "$container" >/dev/null; fi; }
trap cleanup EXIT
# tmpfs overrides the image's data volume; no host volumes or published ports.
docker run --rm -d --name "$container" --network none \
  --tmpfs /var/lib/postgresql/data -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16 >/dev/null
started=true
ready=false
for ((i=0; i<60; i++)); do
  if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
"$ready" || { echo 'PostgreSQL readiness failed' >&2; exit 1; }
psql() { docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"; }
for migration in 20261026050000_catalog_editorial_definitions 20261026060000_catalog_editorial_options 20261027080000_editorial_vocabulary; do
  psql < "migrations/$migration/migration.sql"
done
# Persistent test helpers survive separate psql sessions, inside this container only.
psql <<'SQL'
CREATE SCHEMA proof;
CREATE FUNCTION proof.snapshot() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE name text; rows jsonb; result jsonb := '{}';
BEGIN
  FOR name IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename LOOP
    EXECUTE format('SELECT coalesce(jsonb_agg(row ORDER BY row::text), ''[]'') FROM (SELECT to_jsonb(t) AS row FROM public.%I t) q', name) INTO rows;
    result := result || jsonb_build_object(name, rows);
  END LOOP;
  RETURN result;
END $$;
CREATE FUNCTION proof.reject(statement text, expected text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE before_state jsonb := proof.snapshot(); actual text;
BEGIN
  BEGIN EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS actual = RETURNED_SQLSTATE;
  END;
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Expected %, got % for %', expected, actual, statement; END IF;
  IF proof.snapshot() <> before_state THEN RAISE EXCEPTION 'Rejected input changed stored rows'; END IF;
END $$;
INSERT INTO editorial_families VALUES ('family', 'food', 'Custom family'), ('old-blank', '', 'Legacy label');
INSERT INTO editorial_definitions VALUES ('choice', 'choice', 'multi', 'Custom choice'), ('other', 'other', 'single', 'Other'), ('number', 'number', 'number', 'Number'), ('blank-definition', '', 'text', 'Legacy definition');
INSERT INTO editorial_bindings VALUES ('family', 'choice', 'product', 17);
INSERT INTO editorial_options VALUES ('choice', 'multi', 'a', '2020-01-01', 'Archived label', 9), ('choice', 'multi', 'b', NULL, 'Active label', 4), ('other', 'single', 'foreign', NULL, 'Foreign', 1), ('choice', 'multi', '', NULL, 'Legacy option', 3);
INSERT INTO editorial_units VALUES ('unit', 'number', 'number', NULL, NULL, 8), ('blank-unit', 'number', 'number', '', 'Legacy unit', 7);
CREATE TABLE proof.baseline AS SELECT proof.snapshot() AS data;
SQL
psql < migrations/20261028120000_editorial_production_metadata/migration.sql
psql <<'SQL'
DO $$
DECLARE name text; original jsonb; preserved jsonb;
BEGIN
  FOR name, original IN SELECT key, value FROM proof.baseline, jsonb_each(data) LOOP
    EXECUTE format('SELECT jsonb_agg(row ORDER BY row::text) FROM (SELECT to_jsonb(t) - ARRAY[''minimumContractVersion'',''numericPolicy'',''exposure'',''searchable'',''publicationCheck'',''policy''] AS row FROM public.%I t) q', name) INTO preserved;
    IF preserved <> original THEN RAISE EXCEPTION 'Legacy rows changed in %', name; END IF;
  END LOOP;
  IF EXISTS (SELECT FROM editorial_families WHERE "minimumContractVersion" <> 1)
    OR EXISTS (SELECT FROM editorial_bindings WHERE exposure <> 'INTERNAL' OR searchable OR policy IS NOT NULL OR "publicationCheck" IS NOT NULL)
    OR EXISTS (SELECT FROM editorial_definitions WHERE "numericPolicy" IS NOT NULL)
    OR EXISTS (SELECT FROM editorial_vocabulary_metadata)
  THEN RAISE EXCEPTION 'Unexpected legacy defaults or automatic adoption'; END IF;
END $$;
-- An unrelated label update allowed before this migration must still work.
UPDATE editorial_families SET label = 'Updated legacy label' WHERE id = 'old-blank';
UPDATE editorial_definitions SET label = 'Updated legacy definition' WHERE id = 'blank-definition';
UPDATE editorial_options SET "archivedAt" = '2021-01-01' WHERE "definitionId" = 'choice' AND code = '';
UPDATE editorial_units SET "sortOrder" = 11 WHERE id = 'blank-unit';
INSERT INTO editorial_definitions (id, code, type, label) VALUES ('range', 'range', 'range', 'Range');
INSERT INTO editorial_units (id, "definitionId", "definitionType", "unitCode", label, "sortOrder") VALUES ('range-unit', 'range', 'range', 'cm', 'cm', 0);
INSERT INTO editorial_groups VALUES ('choice', 'multi', 'g1', 'Group one'), ('choice', 'multi', 'g2', 'Group two');
INSERT INTO editorial_group_members VALUES ('choice', 'g1', 'b'), ('choice', 'g2', 'b');
INSERT INTO editorial_aliases VALUES ('choice', 'Alias', 'b');
INSERT INTO editorial_vocabulary_metadata ("semanticsVersion") VALUES ('editorial-production-1');
UPDATE editorial_definitions SET "numericPolicy" = '{"status":"resolved","magnitude":"length","integer":false,"lower":null,"lowerInclusive":true,"upper":null,"upperInclusive":false}' WHERE id = 'range';
UPDATE editorial_bindings SET policy = '{"route":"pending"}', "publicationCheck" = 'when_asserted' WHERE "familyId" = 'family';
SELECT proof.reject($q$INSERT INTO editorial_group_members VALUES ('choice','g1','b')$q$, '23505');
SELECT proof.reject($q$INSERT INTO editorial_group_members VALUES ('choice','g1','foreign')$q$, '23503');
SELECT proof.reject($q$INSERT INTO editorial_aliases VALUES ('choice','Wrong','foreign')$q$, '23503');
SELECT proof.reject($q$INSERT INTO editorial_groups VALUES ('number','number','g','No')$q$, '23514');
SELECT proof.reject($q$INSERT INTO editorial_groups VALUES ('choice','multi',' ','No')$q$, '23514');
SELECT proof.reject($q$INSERT INTO editorial_units (id,"definitionId","definitionType","unitCode",label,"sortOrder") VALUES ('bad','range','range',NULL,NULL,0)$q$, '23514');
SELECT proof.reject($q$UPDATE editorial_definitions SET "numericPolicy" = '{"status":"resolved"}' WHERE id='range'$q$, '23514');
SELECT proof.reject($q$UPDATE editorial_definitions SET "numericPolicy" = '{"status":"pending"}' WHERE id='choice'$q$, '23514');
SELECT proof.reject($q$UPDATE editorial_bindings SET policy = '{"route":"fact_rule","rule":{}}'$q$, '23514');
SELECT proof.reject($q$UPDATE editorial_bindings SET policy = '{"route":"option_cases","cases":false}'$q$, '23514');
SELECT proof.reject($q$UPDATE editorial_bindings SET exposure = 'PUBLIC'$q$, '23514');
SELECT proof.reject($q$UPDATE editorial_bindings SET "publicationCheck" = 'never'$q$, '23514');
SELECT proof.reject($q$UPDATE editorial_families SET "minimumContractVersion" = 3$q$, '23514');
SELECT proof.reject($q$DELETE FROM editorial_options WHERE "definitionId"='choice' AND code='b'$q$, '23503');
SELECT proof.reject($q$UPDATE editorial_options SET code='renamed' WHERE "definitionId"='choice' AND code='b'$q$, '23503');
SELECT proof.reject($q$UPDATE editorial_vocabulary_metadata SET "semanticsVersion"='unsupported'$q$, '23514');
SELECT proof.reject($q$INSERT INTO editorial_vocabulary_metadata ("semanticsVersion") VALUES ('editorial-production-1')$q$, '23505');
SELECT proof.reject($q$UPDATE editorial_vocabulary_metadata SET id='other'$q$, '23514');
SELECT proof.reject($q$INSERT INTO editorial_aliases VALUES ('choice','Alias','b')$q$, '23505');
SELECT proof.reject($q$INSERT INTO editorial_aliases VALUES ('choice',' ','b')$q$, '23514');
SELECT proof.reject($q$INSERT INTO editorial_groups VALUES ('choice','single','wrong-type','Wrong')$q$, '23503');
SELECT proof.reject($q$UPDATE editorial_definitions SET "numericPolicy" = 'null' WHERE id='range'$q$, '23514');
SELECT proof.reject($q$UPDATE editorial_bindings SET policy = 'null'$q$, '23514');
SELECT 'PASS: migration, preservation, defaults, overlaps, scoped references and rejection atomicity';
SQL
