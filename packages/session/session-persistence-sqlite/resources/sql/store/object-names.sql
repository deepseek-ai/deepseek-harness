-- Lists the names of the stored tables, views and indexes, so an installation can tell a complete object set from one
-- that lost a view or index. SQLite's own objects are excluded: no derivation declares one.
SELECT name FROM sqlite_schema WHERE type IN ('table', 'view', 'index') AND name NOT LIKE 'sqlite_%';
