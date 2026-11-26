-- Lists every version 1 frame with the Segment row that now holds its events, Segment by Segment in sequence order.
SELECT f.rowid AS frame, s.segment_id, s.segment_uuid, s.base_seq, f.start_seq, f.end_seq, f.codec, f.payload
FROM frames f JOIN segments s ON s.segment_uuid = f.segment_uuid
ORDER BY s.segment_id, f.start_seq;
