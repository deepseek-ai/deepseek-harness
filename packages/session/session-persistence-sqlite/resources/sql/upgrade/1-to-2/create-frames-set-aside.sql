-- Creates the table that keeps the frames this step could not read; it exists only when there is one.
CREATE TABLE frames_set_aside (
  segment_uuid TEXT NOT NULL,
  start_seq INTEGER NOT NULL,
  end_seq INTEGER NOT NULL,
  codec INTEGER NOT NULL,
  payload BLOB NOT NULL
) STRICT;
