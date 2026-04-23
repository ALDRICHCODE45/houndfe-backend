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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "files_storageKey_key" ON "files"("storageKey");

-- CreateIndex
CREATE INDEX "files_ownerType_ownerId_idx" ON "files"("ownerType", "ownerId");

-- AlterTable
ALTER TABLE "product_images" ADD COLUMN "fileId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "product_images_fileId_key" ON "product_images"("fileId");

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;
