-- Lists every version 1 frame whose Segment row is absent. A foreign-key declaration does not check rows that already
-- exist, so such a frame is stored yet unreachable from any Session, and dropped with the version 1 tables.
SELECT f.rowid AS frame, f.segment_uuid, f.start_seq FROM frames f
WHERE NOT EXISTS (SELECT 1 FROM segments_v1 s WHERE s.segment_uuid = f.segment_uuid)
ORDER BY f.rowid;
