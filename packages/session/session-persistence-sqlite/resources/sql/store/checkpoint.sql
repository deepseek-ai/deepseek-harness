-- Copy committed WAL pages into the main file and return the journal's space to the filesystem.
PRAGMA wal_checkpoint(TRUNCATE);
