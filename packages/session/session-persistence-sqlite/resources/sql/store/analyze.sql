-- Collects the planner statistics that make the derived tables' indexes worth using. Without them SQLite chooses the
-- primary key for the correlated lookups in `session_tools`, scanning every result in the Segment for each tool call:
-- 2.3 s on an 84,000-tool-call store against 22 ms once analyzed. A bounded sample keeps this to a few milliseconds on a
-- 370 MB database, and the statistics describe the same selectivity as a full scan because every index is uniform here.
PRAGMA analysis_limit = 400;
ANALYZE;
PRAGMA analysis_limit = 0;
