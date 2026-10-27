-- Company-wide vocabulary storage; no operational data or vocabulary is loaded.
CREATE TABLE editorial_families (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE
);
CREATE TABLE editorial_definitions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('text', 'boolean', 'number', 'single', 'multi')),
  UNIQUE (id, type)
);
CREATE TABLE editorial_bindings (
  "familyId" TEXT NOT NULL REFERENCES editorial_families(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "definitionId" TEXT NOT NULL REFERENCES editorial_definitions(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  owner TEXT NOT NULL CHECK (owner IN ('product', 'sellable')),
  PRIMARY KEY ("familyId", "definitionId")
);
