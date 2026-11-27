-- Every table of a database, to check that version 2 holds the event-row tables before upgrading.
SELECT name FROM sqlite_schema WHERE type = 'table';
