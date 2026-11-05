-- P4 S1: per-tenant switch, default off. Additive; existing tenants keep today's public catalog.
ALTER TABLE "tenants" ADD COLUMN "catalogRequiresPublishedEditorial" BOOLEAN NOT NULL DEFAULT false;
