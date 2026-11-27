-- Recheck the history, observed open time, and sharing under the same write transaction as eviction.
INSERT INTO cold_segments (segment_id, archive, sha256, bytes)
SELECT s.head_segment_id, ?, ?, ? FROM sessions s JOIN session_heads h USING (session_id)
JOIN segments g ON g.segment_id = s.head_segment_id
WHERE s.session_id = ? AND s.head_segment_id = ? AND h.event_count = ? AND s.last_opened_at = ?
  AND g.parent_id IS NULL AND NOT EXISTS (SELECT 1 FROM segments WHERE parent_id = g.segment_id)
  AND NOT EXISTS (SELECT 1 FROM cold_segments WHERE segment_id = g.segment_id);
