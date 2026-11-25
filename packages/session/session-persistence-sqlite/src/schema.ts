/**
 * Current canonical SQLite schema of the Segment store. Segments, Sessions and
 * events are immutable facts; derived tables live beside them and are rebuilt
 * from events. Opening and upgrading a database belongs to `migrations/`. @module
 */

/** Segment storage schema version, monotonic; each increase has a step in `migrations/`. */
export const SCHEMA_VERSION = 2
/** SQLite `application_id` of a Segment store. */
export const APPLICATION_ID = 0x44535043
/** Tables every current database holds; a database missing one is refused. */
export const TABLES = ['events', 'segment_paths', 'segments', 'sessions']
/** Largest safe integer: a Segment sees its own events without an upper bound. */
const UNBOUNDED_SEQ = Number.MAX_SAFE_INTEGER

/**
 * A header member as a generated column, NULL unless the header is JSON holding the member with that
 * JSON type. A damaged header is then stored like any other, and the store omits its Session when listing.
 */
function member(name: string, type: 'integer' | 'text'): string {
  return `CASE WHEN json_valid(header) AND json_type(header, '$.${name}') = '${type}' THEN header ->> '$.${name}' END`
}

/**
 * Statements that create the current schema objects. The opener stamps `application_id` and `user_version`.
 * `seq` is the event's Session sequence, not an offset within its Segment, so a
 * Segment's `base_seq` is both its first sequence and the cut in its parent.
 * `segment_paths` lists, for each Segment, itself and every ancestor with the
 * exclusive sequence up to which that member's events belong to its history, so
 * a Session's events are one join away with no recursion.
 * `events` is a rowid table: its payloads are large, which a clustered composite
 * key would repeat through interior pages.
 */
export const SCHEMA = `CREATE TABLE segments (
  segment_id INTEGER PRIMARY KEY,
  segment_uuid TEXT NOT NULL UNIQUE,
  parent_id INTEGER REFERENCES segments(segment_id),
  base_seq INTEGER NOT NULL CHECK(base_seq >= 0),
  CHECK((parent_id IS NULL AND base_seq = 0) OR (parent_id IS NOT NULL AND parent_id != segment_id))
) STRICT;
CREATE TABLE segment_paths (
  segment_id INTEGER NOT NULL REFERENCES segments(segment_id),
  member_id INTEGER NOT NULL REFERENCES segments(segment_id),
  end_seq INTEGER NOT NULL CHECK(end_seq >= 0),
  PRIMARY KEY(segment_id, member_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER segments_index_paths AFTER INSERT ON segments BEGIN
  INSERT INTO segment_paths VALUES (NEW.segment_id, NEW.segment_id, ${UNBOUNDED_SEQ});
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
  created_at INTEGER GENERATED ALWAYS AS (${member('createdAt', 'integer')}) VIRTUAL,
  cwd TEXT GENERATED ALWAYS AS (${member('cwd', 'text')}) VIRTUAL,
  parent_session TEXT GENERATED ALWAYS AS (${member('parentSession', 'text')}) VIRTUAL,
  origin TEXT GENERATED ALWAYS AS (${member('origin', 'text')}) VIRTUAL,
  agent_preset TEXT GENERATED ALWAYS AS (${member('agentPreset', 'text')}) VIRTUAL
) STRICT;
CREATE INDEX sessions_by_cwd ON sessions(cwd, created_at);
CREATE INDEX sessions_by_parent ON sessions(parent_session) WHERE parent_session IS NOT NULL;
CREATE TABLE events (
  event_no INTEGER PRIMARY KEY,
  segment_id INTEGER NOT NULL REFERENCES segments(segment_id),
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
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
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
    AND t.seq = (SELECT max(seq) FROM events WHERE segment_id = s.head_segment_id)`
