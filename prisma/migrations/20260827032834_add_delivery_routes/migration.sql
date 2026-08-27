-- delivery-routes / WU1 — Persistence foundation for the DeliveryRoute bounded
-- context. Schema-only addition: no runtime code reads/writes these tables yet.
-- Bounded-context code, CASL/guard extension, Sale mirror, outbox pipeline, and
-- Inngest/email wiring land in WU2 and WU3.
--
-- Design references: design.md §4.2 (DeliveryRoute + DeliveryRouteStop),
-- design.md §4.1 (DeliveryRouteStatus + DeliveryRouteStopStatus enums),
-- design.md §3.7 / ADR-7 (the `activeRouteId` marker column + the
-- Postgres-valid partial unique index at the bottom of this file).

-- CreateEnum
CREATE TYPE "DeliveryRouteStatus" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeliveryRouteStopStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED');

-- CreateTable
CREATE TABLE "delivery_routes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "driverUserId" TEXT NOT NULL,
    "status" "DeliveryRouteStatus" NOT NULL DEFAULT 'DRAFT',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_route_stops" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "status" "DeliveryRouteStopStatus" NOT NULL DEFAULT 'PENDING',
    "checkedInAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "skippedReason" TEXT,
    -- ADR-7: denormalized marker column. Non-null exactly while the owning
    -- route is ACTIVE; cleared on cancel/complete. NOT surfaced on the read
    -- model (design §7.2). Feeds the partial unique index below.
    "activeRouteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_route_stops_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "delivery_routes_tenantId_idx" ON "delivery_routes"("tenantId");

-- CreateIndex
CREATE INDEX "delivery_routes_tenantId_driverUserId_status_idx" ON "delivery_routes"("tenantId", "driverUserId", "status");

-- CreateIndex
CREATE INDEX "delivery_routes_tenantId_status_idx" ON "delivery_routes"("tenantId", "status");

-- CreateIndex
CREATE INDEX "delivery_route_stops_tenantId_idx" ON "delivery_route_stops"("tenantId");

-- CreateIndex
CREATE INDEX "delivery_route_stops_tenantId_saleId_idx" ON "delivery_route_stops"("tenantId", "saleId");

-- CreateIndex
CREATE INDEX "delivery_route_stops_saleId_idx" ON "delivery_route_stops"("saleId");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_route_stops_routeId_sortOrder_key" ON "delivery_route_stops"("routeId", "sortOrder");

-- CreateIndex
-- ADR-7 / design §3.7: Postgres-valid partial unique index. Prisma uses
-- camelCase column names by default (matching the rest of the schema), so
-- "tenantId" and "saleId" are quoted verbatim — NOT snake_case. The `activeRouteId`
-- marker is non-null only while the owning route is ACTIVE; the predicate
-- therefore restricts uniqueness to ACTIVE claims. Two ACTIVE routes claiming
-- the same sale fail the constraint with P2002 (mapped to 409 in WU2).
CREATE UNIQUE INDEX "delivery_route_stops_active_sale_uniq" ON "delivery_route_stops"("tenantId", "saleId") WHERE "activeRouteId" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "delivery_routes" ADD CONSTRAINT "delivery_routes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- ADR-1: driver is a User (not Employee); Restrict prevents a route from
-- outliving its driver.
ALTER TABLE "delivery_routes" ADD CONSTRAINT "delivery_routes_driverUserId_fkey" FOREIGN KEY ("driverUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_route_stops" ADD CONSTRAINT "delivery_route_stops_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Cascade from the route deletes its stops; Restrict from the sale prevents
-- hard-deleting a sale that is referenced by a stop (design ADR-2).
ALTER TABLE "delivery_route_stops" ADD CONSTRAINT "delivery_route_stops_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "delivery_routes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_route_stops" ADD CONSTRAINT "delivery_route_stops_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;