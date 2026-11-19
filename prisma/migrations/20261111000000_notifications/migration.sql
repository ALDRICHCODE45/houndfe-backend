-- human-intervention / unit 6 (contract §5.1, §5.2): in-app notices of the
-- chatbot request inbox and per-person delivery preferences. Additive only:
-- two new tables, no change to an existing table or column.
--
-- Locks: the CREATE TABLE/INDEX statements target empty new tables. The three
-- FKs take a SHARE ROW EXCLUSIVE lock on "tenants" (twice: it is referenced by
-- one FK) and on "users" until the migration commits; they wait behind (and
-- queue writers behind) open transactions on those tables. `SET LOCAL
-- lock_timeout` bounds that wait to 5 s, and Prisma runs this file as one
-- transaction, so on timeout nothing is applied.
-- Deploy note: deploy at low traffic. If it fails on lock timeout, run
--   prisma migrate resolve --rolled-back 20261111000000_notifications
-- and redeploy.

SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "requestId" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "dedupKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "userId" TEXT NOT NULL,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "soundEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex: "my notices, newest first" (keyset by createdAt, id).
CREATE INDEX "notifications_tenantId_userId_createdAt_id_idx" ON "notifications"("tenantId", "userId", "createdAt" DESC, "id" DESC);

-- CreateIndex: idempotent enqueue per (tenant, user, dedupKey). NULL keys
-- never collide.
CREATE UNIQUE INDEX "notifications_tenantId_userId_dedupKey_key" ON "notifications"("tenantId", "userId", "dedupKey");

-- Partial index (migration-authoritative, Prisma cannot express it): the
-- unread badge and the `unread=true` list read only unread rows, so the index
-- stays small however many read notices a person accumulates.
CREATE INDEX "notifications_unread_idx" ON "notifications"("tenantId", "userId", "createdAt" DESC, "id" DESC) WHERE "readAt" IS NULL;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
