-- Schema version 3 of the Segment store: one row per event with optional cold payload archives.
-- The opener stamps application_id and user_version after running this script.

CREATE TABLE segments (
  segment_id INTEGER PRIMARY KEY,
  segment_uuid TEXT NOT NULL UNIQUE,
  parent_id INTEGER REFERENCES segments(segment_id),
  -- Session sequence of the Segment's first event, and therefore the cut in its parent.
  base_seq INTEGER NOT NULL CHECK(base_seq >= 0),
  CHECK((parent_id IS NULL AND base_seq = 0) OR (parent_id IS NOT NULL AND parent_id != segment_id))
) STRICT;

CREATE INDEX segments_by_parent ON segments(parent_id);

-- For each Segment, itself and every ancestor, so a Session's events are one join away with no recursion.
CREATE TABLE segment_paths (
  segment_id INTEGER NOT NULL REFERENCES segments(segment_id),
  member_id INTEGER NOT NULL REFERENCES segments(segment_id),
  -- Exclusive sequence up to which the member's events belong to the Segment's history. A Segment sees its
  -- own events without an upper bound, stored as the largest safe integer.
  end_seq INTEGER NOT NULL CHECK(end_seq >= 0),
  PRIMARY KEY(segment_id, member_id)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER segments_index_paths AFTER INSERT ON segments BEGIN
  INSERT INTO segment_paths VALUES (NEW.segment_id, NEW.segment_id, 9007199254740991);
  INSERT INTO segment_paths SELECT NEW.segment_id, NEW.parent_id, NEW.base_seq WHERE NEW.parent_id IS NOT NULL;
  INSERT INTO segment_paths SELECT NEW.segment_id, member_id, end_seq
    FROM segment_paths WHERE segment_id = NEW.parent_id AND member_id != NEW.parent_id;
END;

CREATE TRIGGER segments_no_reparent BEFORE UPDATE ON segments
  BEGIN SELECT RAISE(ABORT, 'segment ancestry is immutable'); END;

CREATE TRIGGER paths_no_update BEFORE UPDATE ON segment_paths
  BEGIN SELECT RAISE(ABORT, 'segment ancestry is immutable'); END;

CREATE TRIGGER paths_no_delete BEFORE DELETE ON segment_paths
  BEGIN SELECT RAISE(ABORT, 'segment ancestry is immutable'); END;

CREATE TABLE sessions (
  session_key INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  header TEXT NOT NULL,
  head_segment_id INTEGER NOT NULL UNIQUE REFERENCES segments(segment_id),
  inherited_count INTEGER NOT NULL CHECK(inherited_count >= 0),
  -- Header members as generated columns. Each is NULL unless the header is JSON holding the member with the
  -- expected JSON type, so a damaged header is stored like any other and the store omits its Session when listing.
  created_at INTEGER GENERATED ALWAYS AS
    (CASE WHEN json_valid(header) AND json_type(header, '$.createdAt') = 'integer' THEN header ->> '$.createdAt' END) VIRTUAL,
  cwd TEXT GENERATED ALWAYS AS
    (CASE WHEN json_valid(header) AND json_type(header, '$.cwd') = 'text' THEN header ->> '$.cwd' END) VIRTUAL,
  parent_session TEXT GENERATED ALWAYS AS
    (CASE WHEN json_valid(header) AND json_type(header, '$.parentSession') = 'text' THEN header ->> '$.parentSession' END) VIRTUAL,
  origin TEXT GENERATED ALWAYS AS
    (CASE WHEN json_valid(header) AND json_type(header, '$.origin') = 'text' THEN header ->> '$.origin' END) VIRTUAL,
  agent_preset TEXT GENERATED ALWAYS AS
    (CASE WHEN json_valid(header) AND json_type(header, '$.agentPreset') = 'text' THEN header ->> '$.agentPreset' END) VIRTUAL,
  last_opened_at INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE cold_segments (
  segment_id INTEGER PRIMARY KEY REFERENCES segments(segment_id),
  archive TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes > 0)
) STRICT;

-- A rowid table: event payloads are large, and a clustered composite key would repeat through interior pages.
CREATE TABLE events (
  event_no INTEGER PRIMARY KEY,
  segment_id INTEGER NOT NULL REFERENCES segments(segment_id),
  -- The event's Session sequence, not an offset within its Segment.
  seq INTEGER NOT NULL CHECK(seq >= 0),
  type TEXT NOT NULL,
  time INTEGER NOT NULL,
  surface_op TEXT,
  source_seqs TEXT,
  ignorable INTEGER CHECK(ignorable IS NULL OR ignorable = 1),
  codec INTEGER NOT NULL CHECK(codec >= 0),
  data ANY NOT NULL,
  UNIQUE(segment_id, seq),
  CHECK((codec = 0 AND typeof(data) = 'text') OR (codec > 0 AND typeof(data) = 'blob'))
) STRICT;

CREATE INDEX events_by_type ON events(segment_id, type, seq);

-- Only a recorded cold Segment can move its payload between codec 254 and an inline codec.
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
WHEN NEW.event_no IS NOT OLD.event_no OR NEW.segment_id IS NOT OLD.segment_id OR NEW.seq IS NOT OLD.seq
  OR NEW.type IS NOT OLD.type OR NEW.time IS NOT OLD.time OR NEW.surface_op IS NOT OLD.surface_op
  OR NEW.source_seqs IS NOT OLD.source_seqs OR NEW.ignorable IS NOT OLD.ignorable
  OR NOT EXISTS (SELECT 1 FROM cold_segments WHERE segment_id = OLD.segment_id)
  OR NOT ((OLD.codec IN (0, 1) AND NEW.codec = 254 AND length(NEW.data) = 0)
    OR (OLD.codec = 254 AND NEW.codec IN (0, 1)))
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

-- Provider internal: each Segment with its stored event count, which is one past its last stored sequence,
-- less its base; a Segment without events holds none.
CREATE VIEW segment_extents AS
  SELECT s.segment_id, s.segment_uuid, s.parent_id, s.base_seq,
    COALESCE((SELECT seq + 1 FROM events WHERE segment_id = s.segment_id ORDER BY seq DESC LIMIT 1) - s.base_seq, 0)
      AS event_count
  FROM segments s;

-- Provider internal: each Session with its head Segment and its event count across the whole history. A Session
-- whose head Segment row is missing still has a row, with NULL Segment members, which the store reports as corruption.
CREATE VIEW session_heads AS
  SELECT n.session_id, n.header, s.segment_id AS head_segment_id, s.segment_uuid AS head_segment_uuid,
    n.inherited_count, s.base_seq, s.base_seq + s.event_count AS event_count
  FROM sessions n LEFT JOIN segment_extents s ON s.segment_id = n.head_segment_id;

CREATE VIEW session_segments AS
  SELECT s.session_id, m.member_id AS segment_id, m.end_seq
  FROM sessions s JOIN segment_paths m ON m.segment_id = s.head_segment_id;

CREATE VIEW session_events AS
  SELECT p.session_id, e.seq, e.type, e.time, e.surface_op, e.source_seqs, e.ignorable, e.codec, e.data,
    e.segment_id, e.event_no
  FROM session_segments p JOIN events e ON e.segment_id = p.segment_id AND e.seq < p.end_seq;

CREATE VIEW session_summary AS
  SELECT s.session_id, s.created_at, s.cwd, s.parent_session, s.origin, s.agent_preset, s.inherited_count,
    COALESCE(t.seq + 1, g.base_seq) AS event_count, t.time AS last_event_time
  FROM sessions s JOIN segments g ON g.segment_id = s.head_segment_id
  LEFT JOIN events t ON t.segment_id = s.head_segment_id
    AND t.seq = (SELECT max(seq) FROM events WHERE segment_id = s.head_segment_id);
