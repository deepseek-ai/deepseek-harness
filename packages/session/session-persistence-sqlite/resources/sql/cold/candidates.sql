-- Page by session_key so a busy or unreadable Session does not starve later candidates.
SELECT n.session_key, n.session_id, n.header, n.head_segment_id, n.inherited_count, n.last_opened_at, h.event_count
FROM sessions n JOIN session_heads h USING (session_id)
JOIN segments s ON s.segment_id = n.head_segment_id
WHERE n.session_key > ? AND max(n.last_opened_at, n.created_at) <= ? AND h.event_count > 0
  AND (SELECT time FROM events WHERE segment_id = s.segment_id ORDER BY seq DESC LIMIT 1) <= ?
  AND s.parent_id IS NULL AND NOT EXISTS (SELECT 1 FROM segments WHERE parent_id = s.segment_id)
  AND NOT EXISTS (SELECT 1 FROM cold_segments WHERE segment_id = s.segment_id)
  AND NOT EXISTS (SELECT 1 FROM events WHERE segment_id = s.segment_id AND codec = 255)
ORDER BY n.session_key LIMIT ?;
