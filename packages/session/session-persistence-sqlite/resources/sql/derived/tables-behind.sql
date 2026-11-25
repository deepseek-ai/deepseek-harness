-- Lists the derived tables that are behind, with the event_no each has reached.
SELECT name, cursor FROM derivations WHERE cursor IS NOT NULL;
