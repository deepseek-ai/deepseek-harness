-- Drops the version 1 triggers and index and renames the version 1 tables whose names version 2 reuses,
-- so the version 2 schema can be created beside the stored rows.
DROP TRIGGER frames_no_update;
DROP TRIGGER frames_no_delete;
DROP TRIGGER segments_no_reparent;
DROP TRIGGER segments_index_ancestors;
DROP TRIGGER ancestors_no_update;
DROP TRIGGER ancestors_no_delete;
DROP INDEX exclusive_trace_head;
ALTER TABLE segments RENAME TO segments_v1;
ALTER TABLE segment_ancestors RENAME TO segment_ancestors_v1;
