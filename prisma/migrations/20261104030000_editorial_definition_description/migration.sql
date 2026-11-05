-- Optional es-MX help text per vocabulary definition. Additive and nullable: no
-- default, no backfill and no rewrite of existing columns. It never enters the
-- vocabulary snapshot, revision or install before-image (see the snapshot adapter).
ALTER TABLE "editorial_definitions" ADD COLUMN "description" VARCHAR(200);
