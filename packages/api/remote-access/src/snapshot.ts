/**
 * The index global carrying a page's first access snapshot, shared by the
 * Host row that writes it and the Client mount that reads it.
 * @module @deepseek-ai/dsh-api-remote-access/src/snapshot
 */

/** `globalThis` property an index injection row assigns to the page's opening baseline. */
export const REMOTE_ACCESS_SNAPSHOT_KEY = '__DSH_REMOTE_ACCESS__'
