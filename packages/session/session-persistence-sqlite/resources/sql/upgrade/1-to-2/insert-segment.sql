-- Stores one Segment under its version 1 identity, resolving its parent to the row already stored.
-- Binds: segment_uuid, the parent's segment_uuid or NULL, base_seq.
INSERT INTO segments (segment_uuid, parent_id, base_seq)
VALUES (?, (SELECT segment_id FROM segments WHERE segment_uuid = ?), ?);
