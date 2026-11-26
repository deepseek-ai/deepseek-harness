-- Drops the version 1 triggers and index and renames the version 1 tables whose names version 2 reuses,
-- so the version 2 schema can be created beside the stored rows. Each drop tolerates an absent object: a build that
-- narrowed the frame layout left some of them out, and losing a trigger costs no stored event.
DROP TRIGGER IF EXISTS frames_no_update;
DROP TRIGGER IF EXISTS frames_no_delete;
DROP TRIGGER IF EXISTS segments_no_reparent;
DROP TRIGGER IF EXISTS segments_index_ancestors;
DROP TRIGGER IF EXISTS ancestors_no_update;
DROP TRIGGER IF EXISTS ancestors_no_delete;
DROP INDEX IF EXISTS exclusive_trace_head;
ALTER TABLE segments RENAME TO segments_v1;
ALTER TABLE segment_ancestors RENAME TO segment_ancestors_v1;
