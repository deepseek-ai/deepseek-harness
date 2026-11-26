-- Records one derived table, replacing the version and cursor of an earlier record.
-- Binds: name, version, cursor or NULL.
INSERT INTO derivations VALUES (?, ?, ?)
ON CONFLICT(name) DO UPDATE SET version = excluded.version, cursor = excluded.cursor;
