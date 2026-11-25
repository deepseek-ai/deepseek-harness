-- Reads one Segment with its stored event count.
-- Binds: segment_id.
SELECT segment_id, segment_uuid, parent_id, base_seq, event_count
FROM segment_extents WHERE segment_id = ?;
