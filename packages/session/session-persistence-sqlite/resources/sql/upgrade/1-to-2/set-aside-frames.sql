-- Copies the damaged frames unchanged into frames_set_aside.
-- Binds: a JSON array of the frames' rowids.
INSERT INTO frames_set_aside
SELECT segment_uuid, start_seq, end_seq, codec, payload FROM frames
WHERE rowid IN (SELECT value FROM json_each(?));
