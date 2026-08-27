-- delivery-routes / WU1 — Register DELIVERY_NEXT_STOP in the
-- NotificationActionKey enum.
--
-- Standalone ALTER TYPE ADD VALUE per design §4.4. ADD VALUE cannot run
-- inside a transaction block (Postgres constraint), so this migration MUST
-- stay as a single, atomic statement — no other DDL/DML before or after.
--
-- Mirror of 20260717000002_add_time_off_requested/migration.sql.
ALTER TYPE "NotificationActionKey" ADD VALUE IF NOT EXISTS 'DELIVERY_NEXT_STOP';