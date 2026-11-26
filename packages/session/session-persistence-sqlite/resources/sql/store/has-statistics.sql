-- Says whether the planner already has statistics. SQLite creates `sqlite_stat1` the first time it analyzes, so a missing
-- table means this open must analyze once; `PRAGMA optimize` keeps the statistics current on every later close.
SELECT 1 AS present FROM sqlite_schema WHERE name = 'sqlite_stat1';
