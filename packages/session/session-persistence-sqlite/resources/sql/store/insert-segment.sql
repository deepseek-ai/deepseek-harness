-- Stores one Segment.
-- Binds: segment_uuid, parent segment_id or NULL, base_seq.
INSERT INTO segments (segment_uuid, parent_id, base_seq) VALUES (?, ?, ?);
