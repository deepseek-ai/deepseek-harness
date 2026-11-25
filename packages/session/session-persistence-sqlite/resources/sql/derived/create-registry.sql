-- Creates the registry of derived tables: each table's version and, while it is behind, the event_no it has reached.
CREATE TABLE IF NOT EXISTS derivations (
  name TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  cursor INTEGER
) STRICT, WITHOUT ROWID;
