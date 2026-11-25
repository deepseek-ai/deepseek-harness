-- Stores every version 1 trace as a Session, in stored order, with its head Segment resolved by identity.
INSERT INTO sessions (session_id, header, head_segment_id, inherited_count)
SELECT trace_uuid, header, (SELECT segment_id FROM segments WHERE segment_uuid = tail_segment_uuid), inherited_count
FROM traces ORDER BY rowid;
