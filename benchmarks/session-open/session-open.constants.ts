/** Stable identity and released storage location for the Session-opening workload. */

import { join } from 'node:path'

/** Session id encoded in the fixture and used for every measured open. */
export const SYNTHETIC_SESSION_ID = 'bench-session'
/** Stable logical working directory encoded in the fixture header. */
export const SYNTHETIC_SESSION_CWD = '/bench'
/** Storage directory derived from the fixture's cwd and Session id. */
export const SYNTHETIC_SESSION_DIRECTORY = join('--bench--', SYNTHETIC_SESSION_ID)
/** Canonical released-v0 Zstandard generation filename. */
export const SYNTHETIC_V0_FILENAME = 'session.jsonl.zstd'
