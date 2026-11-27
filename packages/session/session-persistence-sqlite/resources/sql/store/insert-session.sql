-- Stores one Session.
-- Binds: session_id, header JSON, head segment_id, inherited_count, last_opened_at.
INSERT INTO sessions (session_id, header, head_segment_id, inherited_count, last_opened_at) VALUES (?, ?, ?, ?, ?);
