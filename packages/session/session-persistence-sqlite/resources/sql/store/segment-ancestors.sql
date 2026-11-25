-- Reads the ancestors of one Segment that hold events at or after an offset, each with its stored event count.
-- Binds: segment_id, the first sequence the read needs.
SELECT s.segment_id, s.segment_uuid, s.parent_id, s.base_seq, s.event_count
FROM segment_extents s JOIN segment_paths p ON p.member_id = s.segment_id
WHERE p.segment_id = ? AND p.member_id != p.segment_id AND p.end_seq > ?;
