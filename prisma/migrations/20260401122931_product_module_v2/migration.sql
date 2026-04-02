-- CreateEnum: ProductType
CREATE TYPE "ProductType" AS ENUM ('PRODUCT', 'SERVICE');

-- CreateEnum: UnitOfMeasure
CREATE TYPE "UnitOfMeasure" AS ENUM ('UNIDAD', 'CAJA', 'BOLSA', 'METRO', 'CENTIMETRO', 'KILOGRAMO', 'GRAMO', 'LITRO');

-- CreateEnum: IvaRate
CREATE TYPE "IvaRate" AS ENUM ('IVA_16', 'IVA_8', 'IVA_0', 'IVA_EXENTO');

-- CreateEnum: IepsRate
CREATE TYPE "IepsRate" AS ENUM ('NO_APLICA', 'IEPS_160', 'IEPS_53', 'IEPS_50', 'IEPS_30_4', 'IEPS_30', 'IEPS_26_5', 'IEPS_25', 'IEPS_9', 'IEPS_8', 'IEPS_7', 'IEPS_6', 'IEPS_3', 'IEPS_0');

-- CreateEnum: PurchaseCostMode
CREATE TYPE "PurchaseCostMode" AS ENUM ('NET', 'GROSS');

-- ============================================================================
-- CATEGORIES
-- ============================================================================
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "categories_name_key" ON "categories"("name");

-- ============================================================================
-- ALTER PRODUCTS: drop old columns, add new columns
-- ============================================================================

-- Drop old columns that are being replaced
ALTER TABLE "products" DROP COLUMN "price";
ALTER TABLE "products" DROP COLUMN "currency";
ALTER TABLE "products" DROP COLUMN "stock";

-- Make sku nullable (was required before)
ALTER TABLE "products" ALTER COLUMN "sku" DROP NOT NULL;

-- Add all new product columns
ALTER TABLE "products" ADD COLUMN "type" "ProductType" NOT NULL DEFAULT 'PRODUCT';
ALTER TABLE "products" ADD COLUMN "barcode" TEXT;
ALTER TABLE "products" ADD COLUMN "unit" "UnitOfMeasure" NOT NULL DEFAULT 'UNIDAD';
ALTER TABLE "products" ADD COLUMN "satKey" TEXT;
ALTER TABLE "products" ADD COLUMN "categoryId" TEXT;
ALTER TABLE "products" ADD COLUMN "sellInPos" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "products" ADD COLUMN "includeInOnlineCatalog" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "products" ADD COLUMN "chargeProductTaxes" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "products" ADD COLUMN "ivaRate" "IvaRate" NOT NULL DEFAULT 'IVA_16';
ALTER TABLE "products" ADD COLUMN "iepsRate" "IepsRate" NOT NULL DEFAULT 'NO_APLICA';
ALTER TABLE "products" ADD COLUMN "purchaseCostMode" "PurchaseCostMode" NOT NULL DEFAULT 'NET';
ALTER TABLE "products" ADD COLUMN "purchaseNetCostCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "products" ADD COLUMN "purchaseGrossCostCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "products" ADD COLUMN "useStock" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "products" ADD COLUMN "useLotsAndExpirations" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "products" ADD COLUMN "quantity" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "products" ADD COLUMN "minQuantity" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "products" ADD COLUMN "hasVariants" BOOLEAN NOT NULL DEFAULT false;

-- Add unique constraint for barcode (nullable)
CREATE UNIQUE INDEX "products_barcode_key" ON "products"("barcode");

-- Add FK to categories
ALTER TABLE "products" ADD CONSTRAINT "products_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- PRODUCT IMAGES
-- ============================================================================
CREATE TABLE "product_images" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "url" TEXT NOT NULL,
    "isMain" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- VARIANTS
-- ============================================================================
CREATE TABLE "variants" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "barcode" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "variants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "variants_sku_key" ON "variants"("sku");
CREATE UNIQUE INDEX "variants_barcode_key" ON "variants"("barcode");

-- ============================================================================
-- VARIANT PRICES
-- ============================================================================
CREATE TABLE "variant_prices" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "priceListId" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    CONSTRAINT "variant_prices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "variant_prices_variantId_priceListId_key" ON "variant_prices"("variantId", "priceListId");

-- ============================================================================
-- LOTS
-- ============================================================================
CREATE TABLE "lots" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "lotNumber" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "manufactureDate" TIMESTAMP(3),
    "expirationDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "lots_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "lots_productId_lotNumber_key" ON "lots"("productId", "lotNumber");

-- ============================================================================
-- PRICE LISTS
-- ============================================================================
CREATE TABLE "price_lists" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "price_lists_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "price_lists_productId_name_key" ON "price_lists"("productId", "name");

-- ============================================================================
-- TIER PRICES
-- ============================================================================
CREATE TABLE "tier_prices" (
    "id" TEXT NOT NULL,
    "priceListId" TEXT NOT NULL,
    "minQuantity" INTEGER NOT NULL,
    "priceCents" INTEGER NOT NULL,
    CONSTRAINT "tier_prices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tier_prices_priceListId_minQuantity_key" ON "tier_prices"("priceListId", "minQuantity");

-- ============================================================================
-- FOREIGN KEYS
-- ============================================================================
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "variants" ADD CONSTRAINT "variants_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "variant_prices" ADD CONSTRAINT "variant_prices_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "variant_prices" ADD CONSTRAINT "variant_prices_priceListId_fkey" FOREIGN KEY ("priceListId") REFERENCES "price_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lots" ADD CONSTRAINT "lots_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tier_prices" ADD CONSTRAINT "tier_prices_priceListId_fkey" FOREIGN KEY ("priceListId") REFERENCES "price_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;
