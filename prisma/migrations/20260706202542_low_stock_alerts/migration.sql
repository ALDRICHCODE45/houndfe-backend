-- CreateEnum
CREATE TYPE "NotificationActionKey" AS ENUM ('LOW_STOCK');

-- CreateTable
CREATE TABLE "notification_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_recipients" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "notification_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_actions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "action" "NotificationActionKey" NOT NULL,

    CONSTRAINT "notification_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_alert_states" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "variantKey" TEXT NOT NULL,
    "alerted" BOOLEAN NOT NULL DEFAULT false,
    "alertEpoch" INTEGER NOT NULL DEFAULT 0,
    "alertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_alert_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_settings_tenantId_key" ON "notification_settings"("tenantId");

-- CreateIndex
CREATE INDEX "notification_recipients_tenantId_idx" ON "notification_recipients"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_recipients_tenantId_userId_key" ON "notification_recipients"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "notification_actions_tenantId_idx" ON "notification_actions"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_actions_tenantId_action_key" ON "notification_actions"("tenantId", "action");

-- CreateIndex
CREATE INDEX "stock_alert_states_tenantId_idx" ON "stock_alert_states"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_alert_states_tenantId_productId_variantKey_key" ON "stock_alert_states"("tenantId", "productId", "variantKey");

-- AddForeignKey
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_recipients" ADD CONSTRAINT "notification_recipients_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_recipients" ADD CONSTRAINT "notification_recipients_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_actions" ADD CONSTRAINT "notification_actions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_alert_states" ADD CONSTRAINT "stock_alert_states_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
