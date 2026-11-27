/**
 * Identity of the Segment store's current schema. The schema itself is SQL in
 * `resources/sql/schema/`, one file per version; opening and upgrading a
 * database belongs to `migrations/`. @module
 */

/** Segment storage schema version, monotonic; each increase has a step in `migrations/`. */
export const SCHEMA_VERSION = 3
/** SQLite `application_id` of a Segment store. */
export const APPLICATION_ID = 0x44535043
/** Tables every current database holds; a database missing one is refused. */
export const TABLES = ['events', 'segment_paths', 'segments', 'sessions', 'cold_segments']
