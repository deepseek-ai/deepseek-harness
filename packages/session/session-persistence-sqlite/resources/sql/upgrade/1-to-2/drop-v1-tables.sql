-- Drops the version 1 tables. Dropping a table checks every row that references it, and the self-reference
-- of segments_v1 needs the index to keep that check linear.
CREATE INDEX segments_v1_parent ON segments_v1(parent_segment_uuid);
DROP TABLE frames;
DROP TABLE traces;
DROP TABLE segment_ancestors_v1;
DROP TABLE segments_v1;
