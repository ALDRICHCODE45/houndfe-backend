-- Child type checks plus composite FKs prevent incompatible parent/child types.
CREATE TABLE editorial_options (
  "definitionId" TEXT NOT NULL,
  "definitionType" TEXT NOT NULL CHECK ("definitionType" IN ('single', 'multi')),
  code TEXT NOT NULL,
  "archivedAt" TIMESTAMP(3),
  PRIMARY KEY ("definitionId", code),
  FOREIGN KEY ("definitionId", "definitionType") REFERENCES editorial_definitions(id, type)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE editorial_units (
  id TEXT PRIMARY KEY,
  "definitionId" TEXT NOT NULL,
  "definitionType" TEXT NOT NULL DEFAULT 'number' CHECK ("definitionType" = 'number'),
  "unitCode" TEXT,
  -- PostgreSQL 15+: null is a real allowed unit, never a magic string sentinel.
  UNIQUE NULLS NOT DISTINCT ("definitionId", "unitCode"),
  FOREIGN KEY ("definitionId", "definitionType") REFERENCES editorial_definitions(id, type)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
