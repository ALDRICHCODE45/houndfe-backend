-- shipping-zones / T1 (S3) — registers the DELIVERY_ZONE_VALIDATION_REQUESTED
-- notification action. Enum-only and in its own file so no later statement in
-- the same transaction uses the new member (mirrors
-- 20260924162000_delivery_thank_you_action). No rows are seeded: the action is
-- disabled until a tenant opts in through PUT /notification-config.
--
-- Rollback (manual): PostgreSQL has no DROP VALUE; recreate the type without
-- the member after deleting any notification_actions row that uses it.
ALTER TYPE "NotificationActionKey" ADD VALUE IF NOT EXISTS 'DELIVERY_ZONE_VALIDATION_REQUESTED';
