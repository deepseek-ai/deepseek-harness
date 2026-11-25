-- Schema version 1 of the Segment store, the frame layout: each durable write is one row of frames holding its
-- events as JSON lines. Reproduces what the release that wrote it created, including its identity pragmas.

CREATE TABLE segments (
  segment_uuid TEXT PRIMARY KEY, parent_segment_uuid TEXT REFERENCES segments(segment_uuid), parent_end_seq INTEGER,
  base_seq INTEGER NOT NULL CHECK(base_seq >= 0),
  CHECK((parent_segment_uuid IS NULL AND parent_end_seq IS NULL AND base_seq = 0)
    OR (parent_segment_uuid IS NOT NULL AND parent_end_seq IS NOT NULL AND parent_end_seq >= 0 AND parent_segment_uuid != segment_uuid))
) STRICT;
CREATE TABLE traces (
  trace_uuid TEXT PRIMARY KEY, header TEXT NOT NULL,
  tail_segment_uuid TEXT NOT NULL REFERENCES segments(segment_uuid),
  inherited_count INTEGER NOT NULL CHECK(inherited_count >= 0)
) STRICT;
CREATE UNIQUE INDEX exclusive_trace_head ON traces(tail_segment_uuid);
CREATE TABLE frames (
  segment_uuid TEXT NOT NULL REFERENCES segments(segment_uuid),
  start_seq INTEGER NOT NULL CHECK(start_seq >= 0), end_seq INTEGER NOT NULL CHECK(end_seq > start_seq),
  codec INTEGER NOT NULL CHECK(codec IN (0, 1)), payload BLOB NOT NULL, PRIMARY KEY(segment_uuid, start_seq)
) STRICT;
CREATE TRIGGER frames_no_update BEFORE UPDATE ON frames BEGIN SELECT RAISE(ABORT, 'frames are append-only'); END;
CREATE TRIGGER frames_no_delete BEFORE DELETE ON frames BEGIN SELECT RAISE(ABORT, 'frames are append-only'); END;
CREATE TRIGGER segments_no_reparent BEFORE UPDATE OF parent_segment_uuid, parent_end_seq, base_seq ON segments
  BEGIN SELECT RAISE(ABORT, 'segment ancestry is immutable'); END;
CREATE TABLE segment_ancestors (
  segment_uuid TEXT NOT NULL REFERENCES segments(segment_uuid),
  ancestor_uuid TEXT NOT NULL REFERENCES segments(segment_uuid),
  end_seq INTEGER NOT NULL CHECK(end_seq >= 0),
  PRIMARY KEY(segment_uuid, ancestor_uuid), CHECK(segment_uuid != ancestor_uuid)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER segments_index_ancestors AFTER INSERT ON segments WHEN NEW.parent_segment_uuid IS NOT NULL BEGIN
  INSERT INTO segment_ancestors VALUES (NEW.segment_uuid, NEW.parent_segment_uuid, NEW.parent_end_seq);
  INSERT INTO segment_ancestors SELECT NEW.segment_uuid, ancestor_uuid, end_seq
    FROM segment_ancestors WHERE segment_uuid = NEW.parent_segment_uuid;
END;
CREATE TRIGGER ancestors_no_update BEFORE UPDATE ON segment_ancestors
  BEGIN SELECT RAISE(ABORT, 'segment ancestry is immutable'); END;
CREATE TRIGGER ancestors_no_delete BEFORE DELETE ON segment_ancestors
  BEGIN SELECT RAISE(ABORT, 'segment ancestry is immutable'); END;
PRAGMA application_id = 0x44535043; PRAGMA user_version = 1;
