-- Lists the names of the stored tables, to confirm the frame layout is present.
SELECT name FROM sqlite_schema WHERE type = 'table';
