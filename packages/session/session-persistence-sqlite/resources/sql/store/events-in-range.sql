-- Reads the event rows of one Segment within a sequence range, in order.
-- Binds: segment_id, first sequence, exclusive last sequence.
SELECT seq, type, time, surface_op, source_seqs, ignorable, codec, data FROM events
WHERE segment_id = ? AND seq >= ? AND seq < ? ORDER BY seq;
