-- Advance the idle watermark when unset or older than the supplied threshold.
UPDATE sessions SET last_opened_at = ? WHERE session_id = ? AND (last_opened_at = 0 OR last_opened_at <= ?);
