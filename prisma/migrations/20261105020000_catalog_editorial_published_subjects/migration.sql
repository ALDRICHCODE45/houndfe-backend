-- P4 S5: offered subjects E the current Published version covered, recorded by
-- publish: a JSON array of variant ids, or [null] for the simple-product
-- presentation. NULL means "not recorded" and covers every subject.
ALTER TABLE "catalog_editorial_states" ADD COLUMN "publishedSubjects" JSONB;

-- Safe default for rows published before recording existed: cover every
-- subject the product has now (every variant, or the simple presentation), so
-- nothing visible today is hidden; variants created later wait for a republish.
UPDATE "catalog_editorial_states" AS s
SET "publishedSubjects" = CASE
  WHEN p."hasVariants" THEN COALESCE(
    (SELECT jsonb_agg(v."id" ORDER BY v."id") FROM "variants" AS v
      WHERE v."tenantId" = s."tenantId" AND v."productId" = s."productId"),
    '[]'::jsonb)
  ELSE '[null]'::jsonb
END
FROM "products" AS p
WHERE p."tenantId" = s."tenantId" AND p."id" = s."productId"
  AND s."publishedRevision" IS NOT NULL;

ALTER TABLE "catalog_editorial_states"
  ADD CONSTRAINT "catalog_editorial_states_published_subjects_check" CHECK (
    "publishedSubjects" IS NULL
    OR ("publishedRevision" IS NOT NULL AND jsonb_typeof("publishedSubjects") = 'array')
  );
