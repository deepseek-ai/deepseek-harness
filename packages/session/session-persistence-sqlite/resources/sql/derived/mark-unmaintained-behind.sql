-- Marks each current table this build does not maintain as behind from the current end of the log.
-- Binds: a JSON array of the table names this build maintains.
UPDATE derivations SET cursor = (SELECT COALESCE(max(event_no), 0) FROM events)
WHERE cursor IS NULL AND name NOT IN (SELECT value FROM json_each(?));
