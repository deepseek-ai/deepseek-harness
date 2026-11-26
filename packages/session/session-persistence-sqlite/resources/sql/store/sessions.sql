-- Lists every Session with its head Segment and event count, ordered by identity, without reading event payloads.
SELECT session_id, header, head_segment_id, head_segment_uuid, inherited_count, base_seq, event_count
FROM session_heads ORDER BY session_id;
