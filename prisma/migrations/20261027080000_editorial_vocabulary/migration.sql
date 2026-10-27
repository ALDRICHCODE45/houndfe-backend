-- Preserve codes and keys. Backfill labels from nonblank codes, otherwise the
-- existing id (options use definitionId, their composite-key parent).
-- Units use unitCode, falling back to id for blank codes; null units keep NULL.
-- Existing ordering starts at zero; code tie-breaking is a read concern.
BEGIN;
ALTER TABLE editorial_families ADD COLUMN label TEXT;
ALTER TABLE editorial_definitions ADD COLUMN label TEXT;
ALTER TABLE editorial_options ADD COLUMN label TEXT;
ALTER TABLE editorial_units ADD COLUMN label TEXT;
ALTER TABLE editorial_bindings ADD COLUMN "sortOrder" INTEGER;
ALTER TABLE editorial_options ADD COLUMN "sortOrder" INTEGER;
ALTER TABLE editorial_units ADD COLUMN "sortOrder" INTEGER;

UPDATE editorial_families SET label = CASE WHEN btrim(code) <> '' THEN code ELSE id END;
UPDATE editorial_definitions SET label = CASE WHEN btrim(code) <> '' THEN code ELSE id END;
UPDATE editorial_options SET label = CASE WHEN btrim(code) <> '' THEN code ELSE "definitionId" END;
UPDATE editorial_units SET label = CASE WHEN "unitCode" IS NULL THEN NULL WHEN btrim("unitCode") <> '' THEN "unitCode" ELSE id END;
UPDATE editorial_bindings SET "sortOrder" = 0;
UPDATE editorial_options SET "sortOrder" = 0;
UPDATE editorial_units SET "sortOrder" = 0;

ALTER TABLE editorial_families ALTER COLUMN label SET NOT NULL;
ALTER TABLE editorial_definitions ALTER COLUMN label SET NOT NULL;
ALTER TABLE editorial_options ALTER COLUMN label SET NOT NULL;
ALTER TABLE editorial_bindings ALTER COLUMN "sortOrder" SET NOT NULL;
ALTER TABLE editorial_options ALTER COLUMN "sortOrder" SET NOT NULL;
ALTER TABLE editorial_units ALTER COLUMN "sortOrder" SET NOT NULL;
ALTER TABLE editorial_families ADD CONSTRAINT editorial_families_label_nonblank CHECK (btrim(label) <> '');
ALTER TABLE editorial_definitions ADD CONSTRAINT editorial_definitions_label_nonblank CHECK (btrim(label) <> '');
ALTER TABLE editorial_options ADD CONSTRAINT editorial_options_label_nonblank CHECK (btrim(label) <> '');
ALTER TABLE editorial_units ADD CONSTRAINT editorial_units_label_nonblank CHECK (label IS NULL OR btrim(label) <> '');
ALTER TABLE editorial_units ADD CONSTRAINT editorial_units_label_null_unit CHECK ((label IS NULL) = ("unitCode" IS NULL));
COMMIT;
