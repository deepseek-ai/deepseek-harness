-- Reads the cold archive locator of one Session's unshared root Segment.
SELECT c.segment_id, c.archive, c.sha256, c.bytes FROM sessions s
JOIN cold_segments c ON c.segment_id = s.head_segment_id WHERE s.session_id = ?;
