-- Retain the event envelope and indexes; release the inline payload bytes.
UPDATE events SET codec = 254, data = X'' WHERE segment_id = ?;
