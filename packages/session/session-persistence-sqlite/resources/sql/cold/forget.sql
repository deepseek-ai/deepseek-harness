-- Retire the locator after all payloads are inline again.
DELETE FROM cold_segments WHERE segment_id = ?;
