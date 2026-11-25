-- Body of the session_tools view: each tool call of a Session with its result when stored. A result can sit in a
-- later Segment than its call, and the lookup is correlated so a filter on one Session never reads another's results.
SELECT p.session_id, c.seq, c.time, c.tool, c.turn, c.step, r.seq AS result_seq,
  r.is_error, r.error_code, r.time - c.time AS duration_ms
FROM sessions p JOIN segment_paths m ON m.segment_id = p.head_segment_id
JOIN tool_calls c ON c.segment_id = m.member_id AND c.seq < m.end_seq
LEFT JOIN tool_results r ON r.call_seq = c.seq
  AND r.segment_id IN (SELECT member_id FROM segment_paths WHERE segment_id = p.head_segment_id)
  AND r.seq < (SELECT end_seq FROM segment_paths WHERE segment_id = p.head_segment_id AND member_id = r.segment_id)
