-- delivery-routes / S2 — reserve a sale from DRAFT assignment.
--
-- The ADR-7 marker column "delivery_route_stops"."activeRouteId" now means
-- "this sale is reserved by this DRAFT-or-ACTIVE route" (previously it was
-- armed only while the owning route was ACTIVE). Existing rows need two
-- things, and they must happen atomically:
--
--   1. REFUSE an ambiguous legacy state. If any (tenantId, saleId) is claimed
--      by more than one DRAFT/ACTIVE route there is no safe owner to choose,
--      so the migration aborts and the data must be resolved by a human. It
--      NEVER deletes, moves or reassigns a stop.
--   2. BACKFILL the reservation for every existing DRAFT/ACTIVE stop that
--      still has a NULL marker, so existing DRAFT reservations become
--      enforced by the EXISTING partial unique index
--      "delivery_route_stops_active_sale_uniq" exactly like new ones. This is
--      the evidence that "reserving a sale from a DRAFT route" already holds
--      for pre-existing drafts, not just newly created ones.
--
-- Both steps run inside ONE DO block: a raised exception aborts the whole
-- block (and the enclosing migration transaction), so the backfill can never
-- run on ambiguous data. No schema change is required — the column and its
-- partial unique index already exist; only their meaning is extended.

DO $$
DECLARE
  ambiguous_sales integer;
BEGIN
  SELECT COUNT(*) INTO ambiguous_sales
    FROM (
      SELECT s."tenantId", s."saleId"
        FROM "delivery_route_stops" s
        JOIN "delivery_routes" r ON r."id" = s."routeId"
       WHERE r."status" IN ('DRAFT', 'ACTIVE')
       GROUP BY s."tenantId", s."saleId"
      HAVING COUNT(*) > 1
    ) AS duplicates;

  IF ambiguous_sales > 0 THEN
    RAISE EXCEPTION
      'reserve_draft_delivery_route_sales: % sale(s) are claimed by more than one DRAFT/ACTIVE route; refusing to backfill. Resolve the duplicates manually — no owner is chosen, nothing is deleted, moved or reassigned.',
      ambiguous_sales;
  END IF;

  UPDATE "delivery_route_stops" s
     SET "activeRouteId" = s."routeId"
    FROM "delivery_routes" r
   WHERE s."routeId" = r."id"
     AND r."status" IN ('DRAFT', 'ACTIVE')
     AND s."activeRouteId" IS NULL;
END $$;
