-- Stores one event row carried over from a frame, or the row that stands in for unreadable stored bytes.
-- Binds: segment_id, seq, type, time, surface_op, source_seqs, ignorable, codec, data.
INSERT INTO events (segment_id, seq, type, time, surface_op, source_seqs, ignorable, codec, data)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
