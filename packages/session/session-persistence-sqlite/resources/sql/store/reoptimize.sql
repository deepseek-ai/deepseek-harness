-- Refreshes the planner statistics of the tables this process changed, so the next open starts from statistics that
-- match the stored rows. Only tables whose row count moved enough to change a plan are analyzed, so this stays cheap.
PRAGMA optimize;
