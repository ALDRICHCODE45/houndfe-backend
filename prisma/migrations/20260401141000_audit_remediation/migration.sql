-- Add product fields requested by audit
ALTER TABLE "products"
  ADD COLUMN "location" TEXT,
  ADD COLUMN "description" TEXT;

-- Enforce one main product-level image (variantId IS NULL)
CREATE UNIQUE INDEX "product_images_one_main_product_level_key"
ON "product_images" ("productId")
WHERE "isMain" = true AND "variantId" IS NULL;

-- Enforce one main image per variant scope
CREATE UNIQUE INDEX "product_images_one_main_variant_key"
ON "product_images" ("variantId")
WHERE "isMain" = true AND "variantId" IS NOT NULL;
