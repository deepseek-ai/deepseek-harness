-- Lists the version 1 Segments with every parent before its children, ordered by their number of ancestors.
SELECT s.segment_uuid, s.parent_segment_uuid, s.parent_end_seq, s.base_seq
FROM segments_v1 s
ORDER BY (SELECT count(*) FROM segment_ancestors_v1 a WHERE a.segment_uuid = s.segment_uuid);
