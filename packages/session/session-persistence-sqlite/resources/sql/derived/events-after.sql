-- Reads the next stored events of the given types after a cursor, in storage order.
-- Binds: event_no cursor, a JSON array of event types, the maximum number of rows.
SELECT event_no, segment_id, seq, type, time, surface_op, source_seqs, ignorable, codec, data FROM events
WHERE event_no > ? AND codec != 254 AND type IN (SELECT value FROM json_each(?)) ORDER BY event_no LIMIT ?;
