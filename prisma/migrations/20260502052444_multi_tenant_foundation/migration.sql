-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('PRODUCT', 'SERVICE');

-- CreateEnum
CREATE TYPE "UnitOfMeasure" AS ENUM ('UNIDAD', 'CAJA', 'BOLSA', 'METRO', 'CENTIMETRO', 'KILOGRAMO', 'GRAMO', 'LITRO');

-- CreateEnum
CREATE TYPE "IvaRate" AS ENUM ('IVA_16', 'IVA_8', 'IVA_0', 'IVA_EXENTO');

-- CreateEnum
CREATE TYPE "IepsRate" AS ENUM ('NO_APLICA', 'IEPS_160', 'IEPS_53', 'IEPS_50', 'IEPS_30_4', 'IEPS_30', 'IEPS_26_5', 'IEPS_25', 'IEPS_9', 'IEPS_8', 'IEPS_7', 'IEPS_6', 'IEPS_3', 'IEPS_0');

-- CreateEnum
CREATE TYPE "PurchaseCostMode" AS ENUM ('NET', 'GROSS');

-- CreateEnum
CREATE TYPE "PromotionType" AS ENUM ('PRODUCT_DISCOUNT', 'ORDER_DISCOUNT', 'BUY_X_GET_Y', 'ADVANCED');

-- CreateEnum
CREATE TYPE "PromotionMethod" AS ENUM ('AUTOMATIC', 'MANUAL');

-- CreateEnum
CREATE TYPE "PromotionStatus" AS ENUM ('ACTIVE', 'SCHEDULED', 'ENDED');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('PERCENTAGE', 'FIXED');

-- CreateEnum
CREATE TYPE "PromotionTargetType" AS ENUM ('CATEGORIES', 'BRANDS', 'PRODUCTS');

-- CreateEnum
CREATE TYPE "CustomerScope" AS ENUM ('ALL', 'REGISTERED_ONLY', 'SPECIFIC');

-- CreateEnum
CREATE TYPE "DayOfWeek" AS ENUM ('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY');

-- CreateEnum
CREATE TYPE "TargetSide" AS ENUM ('DEFAULT', 'BUY', 'GET');

-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('DRAFT');

-- CreateEnum
CREATE TYPE "SaleItemPriceSource" AS ENUM ('DEFAULT', 'PRICE_LIST', 'CUSTOM');

-- CreateEnum
CREATE TYPE "SaleItemDiscountType" AS ENUM ('amount', 'percentage');

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brands" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "address" TEXT,
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT,
    "description" TEXT,
    "type" "ProductType" NOT NULL DEFAULT 'PRODUCT',
    "sku" TEXT,
    "barcode" TEXT,
    "tenantId" TEXT NOT NULL,
    "unit" "UnitOfMeasure" NOT NULL DEFAULT 'UNIDAD',
    "satKey" TEXT,
    "categoryId" TEXT,
    "brandId" TEXT,
    "sellInPos" BOOLEAN NOT NULL DEFAULT true,
    "includeInOnlineCatalog" BOOLEAN NOT NULL DEFAULT true,
    "requiresPrescription" BOOLEAN NOT NULL DEFAULT false,
    "chargeProductTaxes" BOOLEAN NOT NULL DEFAULT true,
    "ivaRate" "IvaRate" NOT NULL DEFAULT 'IVA_16',
    "iepsRate" "IepsRate" NOT NULL DEFAULT 'NO_APLICA',
    "purchaseCostMode" "PurchaseCostMode" NOT NULL DEFAULT 'NET',
    "purchaseNetCostCents" INTEGER NOT NULL DEFAULT 0,
    "purchaseGrossCostCents" INTEGER NOT NULL DEFAULT 0,
    "useStock" BOOLEAN NOT NULL DEFAULT true,
    "useLotsAndExpirations" BOOLEAN NOT NULL DEFAULT false,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "minQuantity" INTEGER NOT NULL DEFAULT 0,
    "hasVariants" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "files" (
    "id" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "ownerType" TEXT,
    "ownerId" TEXT,
    "uploadedBy" TEXT,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_images" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "fileId" TEXT,
    "url" TEXT NOT NULL,
    "isMain" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variants" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "option" TEXT,
    "value" TEXT,
    "sku" TEXT,
    "barcode" TEXT,
    "tenantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "minQuantity" INTEGER NOT NULL DEFAULT 0,
    "purchaseNetCostCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variant_prices" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "priceListId" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "variant_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variant_tier_prices" (
    "id" TEXT NOT NULL,
    "variantPriceId" TEXT NOT NULL,
    "minQuantity" INTEGER NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "variant_tier_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lots" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "lotNumber" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "manufactureDate" TIMESTAMP(3),
    "expirationDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "global_price_lists" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "global_price_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_lists" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "globalPriceListId" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tier_prices" (
    "id" TEXT NOT NULL,
    "priceListId" TEXT NOT NULL,
    "minQuantity" INTEGER NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "tier_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,
    "unitPriceCurrency" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "SaleStatus" NOT NULL DEFAULT 'DRAFT',
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_items" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "productName" TEXT NOT NULL,
    "variantName" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,
    "unitPriceCurrency" TEXT NOT NULL DEFAULT 'MXN',
    "originalPriceCents" INTEGER,
    "priceSource" "SaleItemPriceSource",
    "appliedPriceListId" TEXT,
    "customPriceCents" INTEGER,
    "discountType" "SaleItemDiscountType",
    "discountValue" INTEGER,
    "discountAmountCents" INTEGER,
    "prePriceCentsBeforeDiscount" INTEGER,
    "discountTitle" TEXT,
    "discountedAt" TIMESTAMP(3),
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sale_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "hashedPassword" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "hashedRefreshToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tenantId" TEXT,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_memberships" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,

    CONSTRAINT "tenant_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "phoneCountryCode" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "comments" TEXT,
    "tenantId" TEXT NOT NULL,
    "globalPriceListId" TEXT,
    "businessName" TEXT,
    "fiscalZipCode" TEXT,
    "rfc" TEXT,
    "fiscalRegime" TEXT,
    "billingStreet" TEXT,
    "billingExteriorNumber" TEXT,
    "billingInteriorNumber" TEXT,
    "billingZipCode" TEXT,
    "billingNeighborhood" TEXT,
    "billingMunicipality" TEXT,
    "billingCity" TEXT,
    "billingState" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_addresses" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "street" TEXT NOT NULL,
    "exteriorNumber" TEXT,
    "interiorNumber" TEXT,
    "zipCode" TEXT,
    "neighborhood" TEXT,
    "municipality" TEXT,
    "city" TEXT,
    "state" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotions" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "PromotionType" NOT NULL,
    "method" "PromotionMethod" NOT NULL,
    "status" "PromotionStatus" NOT NULL DEFAULT 'ACTIVE',
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "customerScope" "CustomerScope" NOT NULL DEFAULT 'ALL',
    "discountType" "DiscountType",
    "discountValue" INTEGER,
    "minPurchaseAmountCents" INTEGER,
    "appliesTo" "PromotionTargetType",
    "buyQuantity" INTEGER,
    "getQuantity" INTEGER,
    "getDiscountPercent" INTEGER,
    "buyTargetType" "PromotionTargetType",
    "getTargetType" "PromotionTargetType",
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_target_items" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "side" "TargetSide" NOT NULL DEFAULT 'DEFAULT',
    "targetType" "PromotionTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "promotion_target_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_customers" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "promotion_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_price_lists" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "globalPriceListId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "promotion_price_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_days_of_week" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "day" "DayOfWeek" NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "promotion_days_of_week_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "categories_name_key" ON "categories"("name");

-- CreateIndex
CREATE UNIQUE INDEX "brands_name_key" ON "brands"("name");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "products_tenantId_idx" ON "products"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "files_storageKey_key" ON "files"("storageKey");

-- CreateIndex
CREATE INDEX "files_ownerType_ownerId_idx" ON "files"("ownerType", "ownerId");

-- CreateIndex
CREATE INDEX "files_tenantId_idx" ON "files"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "product_images_fileId_key" ON "product_images"("fileId");

-- CreateIndex
CREATE INDEX "product_images_tenantId_idx" ON "product_images"("tenantId");

-- CreateIndex
CREATE INDEX "variants_tenantId_idx" ON "variants"("tenantId");

-- CreateIndex
CREATE INDEX "variant_prices_tenantId_idx" ON "variant_prices"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "variant_prices_tenantId_variantId_priceListId_key" ON "variant_prices"("tenantId", "variantId", "priceListId");

-- CreateIndex
CREATE INDEX "variant_tier_prices_tenantId_idx" ON "variant_tier_prices"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "variant_tier_prices_tenantId_variantPriceId_minQuantity_key" ON "variant_tier_prices"("tenantId", "variantPriceId", "minQuantity");

-- CreateIndex
CREATE INDEX "lots_tenantId_idx" ON "lots"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "lots_productId_lotNumber_key" ON "lots"("productId", "lotNumber");

-- CreateIndex
CREATE INDEX "global_price_lists_tenantId_idx" ON "global_price_lists"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "global_price_lists_tenantId_name_key" ON "global_price_lists"("tenantId", "name");

-- CreateIndex
CREATE INDEX "price_lists_tenantId_idx" ON "price_lists"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "price_lists_tenantId_productId_globalPriceListId_key" ON "price_lists"("tenantId", "productId", "globalPriceListId");

-- CreateIndex
CREATE INDEX "tier_prices_tenantId_idx" ON "tier_prices"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "tier_prices_tenantId_priceListId_minQuantity_key" ON "tier_prices"("tenantId", "priceListId", "minQuantity");

-- CreateIndex
CREATE INDEX "orders_tenantId_idx" ON "orders"("tenantId");

-- CreateIndex
CREATE INDEX "orders_tenantId_status_idx" ON "orders"("tenantId", "status");

-- CreateIndex
CREATE INDEX "order_items_tenantId_idx" ON "order_items"("tenantId");

-- CreateIndex
CREATE INDEX "sales_tenantId_idx" ON "sales"("tenantId");

-- CreateIndex
CREATE INDEX "sales_tenantId_createdAt_idx" ON "sales"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "sales_userId_status_idx" ON "sales"("userId", "status");

-- CreateIndex
CREATE INDEX "sale_items_saleId_idx" ON "sale_items"("saleId");

-- CreateIndex
CREATE INDEX "sale_items_tenantId_idx" ON "sale_items"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_subject_action_key" ON "permissions"("subject", "action");

-- CreateIndex
CREATE INDEX "roles_tenantId_idx" ON "roles"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenantId_name_key" ON "roles"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_roleId_permissionId_key" ON "role_permissions"("roleId", "permissionId");

-- CreateIndex
CREATE INDEX "tenant_memberships_tenantId_idx" ON "tenant_memberships"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_memberships_userId_tenantId_roleId_key" ON "tenant_memberships"("userId", "tenantId", "roleId");

-- CreateIndex
CREATE INDEX "customers_tenantId_idx" ON "customers"("tenantId");

-- CreateIndex
CREATE INDEX "customer_addresses_tenantId_idx" ON "customer_addresses"("tenantId");

-- CreateIndex
CREATE INDEX "promotions_tenantId_idx" ON "promotions"("tenantId");

-- CreateIndex
CREATE INDEX "promotions_type_idx" ON "promotions"("type");

-- CreateIndex
CREATE INDEX "promotions_method_idx" ON "promotions"("method");

-- CreateIndex
CREATE INDEX "promotions_status_startDate_endDate_idx" ON "promotions"("status", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "promotion_target_items_tenantId_idx" ON "promotion_target_items"("tenantId");

-- CreateIndex
CREATE INDEX "promotion_target_items_targetType_targetId_idx" ON "promotion_target_items"("targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_target_items_promotionId_side_targetType_targetId_key" ON "promotion_target_items"("promotionId", "side", "targetType", "targetId");

-- CreateIndex
CREATE INDEX "promotion_customers_tenantId_idx" ON "promotion_customers"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_customers_promotionId_customerId_key" ON "promotion_customers"("promotionId", "customerId");

-- CreateIndex
CREATE INDEX "promotion_price_lists_tenantId_idx" ON "promotion_price_lists"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_price_lists_promotionId_globalPriceListId_key" ON "promotion_price_lists"("promotionId", "globalPriceListId");

-- CreateIndex
CREATE INDEX "promotion_days_of_week_tenantId_idx" ON "promotion_days_of_week"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_days_of_week_promotionId_day_key" ON "promotion_days_of_week"("promotionId", "day");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variants" ADD CONSTRAINT "variants_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variants" ADD CONSTRAINT "variants_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_prices" ADD CONSTRAINT "variant_prices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_prices" ADD CONSTRAINT "variant_prices_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_prices" ADD CONSTRAINT "variant_prices_priceListId_fkey" FOREIGN KEY ("priceListId") REFERENCES "price_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_tier_prices" ADD CONSTRAINT "variant_tier_prices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_tier_prices" ADD CONSTRAINT "variant_tier_prices_variantPriceId_fkey" FOREIGN KEY ("variantPriceId") REFERENCES "variant_prices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lots" ADD CONSTRAINT "lots_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lots" ADD CONSTRAINT "lots_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "global_price_lists" ADD CONSTRAINT "global_price_lists_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_globalPriceListId_fkey" FOREIGN KEY ("globalPriceListId") REFERENCES "global_price_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tier_prices" ADD CONSTRAINT "tier_prices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tier_prices" ADD CONSTRAINT "tier_prices_priceListId_fkey" FOREIGN KEY ("priceListId") REFERENCES "price_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_globalPriceListId_fkey" FOREIGN KEY ("globalPriceListId") REFERENCES "global_price_lists"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_target_items" ADD CONSTRAINT "promotion_target_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_target_items" ADD CONSTRAINT "promotion_target_items_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_customers" ADD CONSTRAINT "promotion_customers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_customers" ADD CONSTRAINT "promotion_customers_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_customers" ADD CONSTRAINT "promotion_customers_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_price_lists" ADD CONSTRAINT "promotion_price_lists_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_price_lists" ADD CONSTRAINT "promotion_price_lists_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_price_lists" ADD CONSTRAINT "promotion_price_lists_globalPriceListId_fkey" FOREIGN KEY ("globalPriceListId") REFERENCES "global_price_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_days_of_week" ADD CONSTRAINT "promotion_days_of_week_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_days_of_week" ADD CONSTRAINT "promotion_days_of_week_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
