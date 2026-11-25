-- Finds the deepest ancestor that starts at or before a fork's cut; visible_end counts that ancestor's events
-- in the forked history. Binds: head segment_id of the forked Session, the Session sequence of the cut.
SELECT s.segment_id, s.segment_uuid, s.parent_id, s.base_seq, s.event_count, p.end_seq - s.base_seq AS visible_end
FROM segment_paths p JOIN segment_extents s ON s.segment_id = p.member_id
WHERE p.segment_id = ? AND p.member_id != p.segment_id AND s.base_seq <= ?
ORDER BY s.base_seq DESC, p.end_seq DESC LIMIT 1;
