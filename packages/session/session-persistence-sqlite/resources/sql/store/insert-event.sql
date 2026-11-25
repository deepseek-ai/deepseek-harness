-- Stores one event row.
-- Binds: segment_id, seq, type, time, surface_op, source_seqs, ignorable, codec, data.
INSERT INTO events (segment_id, seq, type, time, surface_op, source_seqs, ignorable, codec, data)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
