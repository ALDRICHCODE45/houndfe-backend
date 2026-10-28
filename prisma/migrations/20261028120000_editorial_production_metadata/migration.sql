-- Storage only: no production vocabulary activation or existing-row adoption.
BEGIN;
ALTER TABLE editorial_families ADD COLUMN "minimumContractVersion" INTEGER NOT NULL DEFAULT 1
  CHECK ("minimumContractVersion" IN (1, 2));
ALTER TABLE editorial_definitions ADD COLUMN "numericPolicy" JSONB;
ALTER TABLE editorial_bindings
  ADD COLUMN exposure TEXT NOT NULL DEFAULT 'INTERNAL' CHECK (exposure IN ('INTERNAL', 'DETAIL', 'FACET')),
  ADD COLUMN searchable BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "publicationCheck" TEXT CHECK ("publicationCheck" IN ('always', 'when_asserted')),
  ADD COLUMN policy JSONB;

ALTER TABLE editorial_definitions DROP CONSTRAINT editorial_definitions_type_check;
ALTER TABLE editorial_definitions ADD CONSTRAINT editorial_definitions_type_check
  CHECK (type IN ('text', 'boolean', 'number', 'single', 'multi', 'range'));
ALTER TABLE editorial_units DROP CONSTRAINT "editorial_units_definitionType_check";
ALTER TABLE editorial_units ADD CONSTRAINT "editorial_units_definitionType_check"
  CHECK ("definitionType" IN ('number', 'range'));
ALTER TABLE editorial_units ADD CONSTRAINT editorial_units_range_named
  CHECK ("definitionType" <> 'range' OR "unitCode" IS NOT NULL);

ALTER TABLE editorial_definitions ADD CONSTRAINT editorial_definitions_numeric_policy_shape CHECK (
  "numericPolicy" IS NULL OR (type IN ('number', 'range') AND COALESCE(
    jsonb_typeof("numericPolicy") = 'object' AND (
      "numericPolicy" = '{"status":"pending"}'::jsonb OR (
        "numericPolicy"->>'status' = 'resolved'
        AND "numericPolicy" ?& ARRAY['magnitude','integer','lower','lowerInclusive','upper','upperInclusive']
        AND jsonb_typeof("numericPolicy"->'magnitude') = 'string'
        AND btrim("numericPolicy"->>'magnitude') <> ''
        AND jsonb_typeof("numericPolicy"->'integer') = 'boolean'
        AND jsonb_typeof("numericPolicy"->'lowerInclusive') = 'boolean'
        AND jsonb_typeof("numericPolicy"->'upperInclusive') = 'boolean'
        AND jsonb_typeof("numericPolicy"->'lower') IN ('number', 'null')
        AND jsonb_typeof("numericPolicy"->'upper') IN ('number', 'null')
      )
    ), false))
);
ALTER TABLE editorial_bindings ADD CONSTRAINT editorial_bindings_policy_shape CHECK (
  policy IS NULL OR COALESCE(jsonb_typeof(policy) = 'object' AND (
    policy = '{"route":"pending"}'::jsonb
    OR (policy->>'route' = 'option_cases' AND jsonb_typeof(policy->'cases') = 'array')
    OR (policy->>'route' = 'fact_rule' AND jsonb_typeof(policy->'rule') = 'object'
      AND jsonb_typeof(policy->'rule'->'family') = 'string'
      AND btrim(policy->'rule'->>'family') <> ''
      AND jsonb_typeof(policy->'rule'->'parameter') = 'string'
      AND btrim(policy->'rule'->>'parameter') <> ''
      AND policy->'rule'->>'ruleId' IN ('required','optional','animal','form','content','dimensions',
        'fit','capacity','space','equipment','optional_equipment','presentation'))
  ), false)
);

CREATE TABLE editorial_groups (
  "definitionId" TEXT NOT NULL,
  "definitionType" TEXT NOT NULL CHECK ("definitionType" IN ('single', 'multi')),
  code TEXT NOT NULL CHECK (btrim(code) <> ''),
  label TEXT NOT NULL CHECK (btrim(label) <> ''),
  PRIMARY KEY ("definitionId", code),
  FOREIGN KEY ("definitionId", "definitionType") REFERENCES editorial_definitions(id, type)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE editorial_group_members (
  "definitionId" TEXT NOT NULL,
  "groupCode" TEXT NOT NULL,
  "optionCode" TEXT NOT NULL,
  PRIMARY KEY ("definitionId", "groupCode", "optionCode"),
  FOREIGN KEY ("definitionId", "groupCode") REFERENCES editorial_groups("definitionId", code)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("definitionId", "optionCode") REFERENCES editorial_options("definitionId", code)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE editorial_aliases (
  "definitionId" TEXT NOT NULL,
  label TEXT NOT NULL CHECK (btrim(label) <> ''),
  "optionCode" TEXT NOT NULL,
  PRIMARY KEY ("definitionId", label),
  FOREIGN KEY ("definitionId", "optionCode") REFERENCES editorial_options("definitionId", code)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE editorial_vocabulary_metadata (
  id TEXT PRIMARY KEY DEFAULT 'global' CHECK (id = 'global'),
  "semanticsVersion" TEXT NOT NULL CHECK ("semanticsVersion" = 'editorial-production-1')
);
COMMIT;
