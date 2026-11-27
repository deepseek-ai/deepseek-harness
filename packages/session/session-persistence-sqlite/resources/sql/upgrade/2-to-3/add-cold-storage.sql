-- Adds open watermarks, parent Segment indexing, cold archive metadata, and the cold payload update trigger in place
-- without renaming tables or disturbing derived views.
ALTER TABLE sessions ADD COLUMN last_opened_at INTEGER NOT NULL DEFAULT 0;

CREATE INDEX segments_by_parent ON segments(parent_id);

CREATE TABLE cold_segments (
  segment_id INTEGER PRIMARY KEY REFERENCES segments(segment_id),
  archive TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes > 0)
) STRICT;

DROP TRIGGER IF EXISTS events_no_update;

-- Only a recorded cold Segment can move its payload between codec 254 and an inline codec.
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
WHEN NEW.event_no IS NOT OLD.event_no OR NEW.segment_id IS NOT OLD.segment_id OR NEW.seq IS NOT OLD.seq
  OR NEW.type IS NOT OLD.type OR NEW.time IS NOT OLD.time OR NEW.surface_op IS NOT OLD.surface_op
  OR NEW.source_seqs IS NOT OLD.source_seqs OR NEW.ignorable IS NOT OLD.ignorable
  OR NOT EXISTS (SELECT 1 FROM cold_segments WHERE segment_id = OLD.segment_id)
  OR NOT ((OLD.codec IN (0, 1) AND NEW.codec = 254 AND length(NEW.data) = 0)
    OR (OLD.codec = 254 AND NEW.codec IN (0, 1)))
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
