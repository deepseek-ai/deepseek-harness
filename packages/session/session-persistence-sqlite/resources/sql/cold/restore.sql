-- Restore the payload of one indexed event of the cold Segment, matching replace surface_op values regardless of key order.
UPDATE events SET codec = ?1, data = ?2 WHERE segment_id = ?3 AND seq = ?4 AND codec = 254
  AND type = ?5 AND time = ?6 AND source_seqs IS ?8 AND ignorable IS ?9
  AND (surface_op IS ?7 OR (json_valid(surface_op) AND json_valid(?7)
    AND surface_op ->> '$.op' = ?7 ->> '$.op'
    AND surface_op ->> '$.startSeq' = ?7 ->> '$.startSeq'
    AND surface_op ->> '$.endSeq' = ?7 ->> '$.endSeq'));
