-- Reads one Session with its head Segment and event count.
-- Binds: session_id.
SELECT session_id, header, head_segment_id, head_segment_uuid, inherited_count, base_seq, event_count
FROM session_heads WHERE session_id = ?;
