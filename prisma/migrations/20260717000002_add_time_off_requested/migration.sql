-- Slice 3 / WU3 — Register TIME_OFF_REQUESTED in the NotificationActionKey enum.
--
-- Standalone ALTER TYPE ADD VALUE per design D4 (split from the
-- destructive `retire_employee_userid` migration). ADD VALUE cannot run
-- inside a transaction block (Postgres constraint), so this migration
-- MUST stay as a single, atomic statement — no other DDL/DML before or
-- after.
ALTER TYPE "NotificationActionKey" ADD VALUE IF NOT EXISTS 'TIME_OFF_REQUESTED';