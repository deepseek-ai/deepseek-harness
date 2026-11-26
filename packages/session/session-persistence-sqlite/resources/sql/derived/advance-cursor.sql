-- Moves the cursor of one derived table, or clears it once the table has caught up.
-- Binds: cursor or NULL, name.
UPDATE derivations SET cursor = ? WHERE name = ?;
