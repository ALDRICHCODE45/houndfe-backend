-- shipping-zones / T2 (S4, S5): packaging per product/variant, standard boxes
-- and the shipping origin per sucursal. Additive only.

-- CreateTable
CREATE TABLE "product_packagings" (
    "productId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "weightG" INTEGER NOT NULL,
    "lengthCm" DECIMAL(5,1) NOT NULL,
    "widthCm" DECIMAL(5,1) NOT NULL,
    "heightCm" DECIMAL(5,1) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_packagings_pkey" PRIMARY KEY ("productId")
);

-- CreateTable
CREATE TABLE "variant_packagings" (
    "variantId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "weightG" INTEGER NOT NULL,
    "lengthCm" DECIMAL(5,1) NOT NULL,
    "widthCm" DECIMAL(5,1) NOT NULL,
    "heightCm" DECIMAL(5,1) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "variant_packagings_pkey" PRIMARY KEY ("variantId")
);

-- CreateTable
CREATE TABLE "shipping_boxes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "innerLengthCm" DECIMAL(5,1) NOT NULL,
    "innerWidthCm" DECIMAL(5,1) NOT NULL,
    "innerHeightCm" DECIMAL(5,1) NOT NULL,
    "weightG" INTEGER NOT NULL,
    "maxContentWeightG" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipping_boxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipping_origins" (
    "tenantId" TEXT NOT NULL,
    "addressLine1" TEXT NOT NULL,
    "addressLine2" TEXT,
    "neighborhood" TEXT NOT NULL,
    "municipality" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "postalCode" CHAR(5) NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipping_origins_pkey" PRIMARY KEY ("tenantId")
);

-- CreateIndex
CREATE INDEX "product_packagings_tenantId_idx" ON "product_packagings"("tenantId");

-- CreateIndex
CREATE INDEX "variant_packagings_tenantId_idx" ON "variant_packagings"("tenantId");

-- CreateIndex
CREATE INDEX "shipping_boxes_tenantId_isActive_idx" ON "shipping_boxes"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "shipping_boxes_tenantId_name_key" ON "shipping_boxes"("tenantId", "name");

-- AddForeignKey
ALTER TABLE "product_packagings" ADD CONSTRAINT "product_packagings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_packagings" ADD CONSTRAINT "product_packagings_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_packagings" ADD CONSTRAINT "variant_packagings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_packagings" ADD CONSTRAINT "variant_packagings_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_boxes" ADD CONSTRAINT "shipping_boxes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_origins" ADD CONSTRAINT "shipping_origins_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Defense in depth: positive measures (Prisma does not model CHECK constraints).
ALTER TABLE "product_packagings" ADD CONSTRAINT "product_packagings_positive_chk" CHECK ("weightG" > 0 AND "lengthCm" > 0 AND "widthCm" > 0 AND "heightCm" > 0);
ALTER TABLE "variant_packagings" ADD CONSTRAINT "variant_packagings_positive_chk" CHECK ("weightG" > 0 AND "lengthCm" > 0 AND "widthCm" > 0 AND "heightCm" > 0);
ALTER TABLE "shipping_boxes" ADD CONSTRAINT "shipping_boxes_positive_chk" CHECK ("weightG" > 0 AND "maxContentWeightG" > 0 AND "innerLengthCm" > 0 AND "innerWidthCm" > 0 AND "innerHeightCm" > 0);
ALTER TABLE "shipping_origins" ADD CONSTRAINT "shipping_origins_postal_code_chk" CHECK ("postalCode" ~ '^[0-9]{5}$');
