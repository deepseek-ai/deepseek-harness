/**
 * Per-harness-home anonymous user id shared by telemetry and feedback.
 *
 * The id is a random UUID persisted as a bare line in `.anonymous-user-id` inside the
 * harness home resolved by {@link resolveDshHome} (`$DSH_HOME` > `~/.dsh`),
 * and never derived from the hostname, network address, git remote, or any
 * other identifying source. It is scoped to the harness home, not the
 * machine: every process sharing one `$DSH_HOME` reports the same id, and
 * deleting the file mints a fresh identity on the next launch.
 *
 * Reads and writes are synchronous so boot-time and command consumers can
 * use one API. The result is memoized per resolved file path: one process
 * touches the disk once, and a file deleted mid-run keeps the process's id
 * until the next launch.
 *
 * @module @deepseek-ai/dsh-anonymous-user-id
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** A harness-home-scoped anonymous user id (random UUID v4). */
export type AnonymousUserId = Branded<'AnonymousUserId'>

/** File inside the harness home storing the id: a bare UUID line, no wrapper format. */
export const ANONYMOUS_USER_ID_FILE_NAME = '.anonymous-user-id'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Ambient hooks for locating and generating the id; every field has a default. */
export interface AnonymousUserIdOptions {
  /** Environment consulted for `DSH_HOME`; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** UUID generator; defaults to `crypto.randomUUID` (test hook). */
  randomUUID?: () => string
}

/** Process-lifetime memo keyed by resolved file path, so distinct test homes never share an id. */
const memo = new Map<string, AnonymousUserId>()

/** Read a valid persisted id from the file, or `undefined` when absent/corrupt. */
function readPersistedId(file: string): AnonymousUserId | undefined {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    // Absent or unreadable: the caller mints and persists a fresh id.
    return undefined
  }
  const value = text.trim()
  return UUID_PATTERN.test(value) ? (value as AnonymousUserId) : undefined
}

/**
 * Return the harness home's anonymous user id, creating and persisting one on
 * first use. A concurrent first launch is settled by an exclusive-create
 * write: the loser rereads the winner's id. (A reread landing in the winner's
 * narrow create-to-write window can still yield two per-process ids for that
 * run; the next launch converges on the persisted one.) Persistence is
 * best-effort — a write failure (read-only home) still returns a usable id
 * for the current run so feedback and telemetry are never blocked.
 * @param options - home-location and UUID-generation seams.
 * @returns the stable per-harness-home anonymous user id.
 */
export function getOrCreateAnonymousUserId(options: AnonymousUserIdOptions = {}): AnonymousUserId {
  const file = join(resolveDshHome(undefined, options.env ?? process.env), ANONYMOUS_USER_ID_FILE_NAME)
  const cached = memo.get(file)
  if (cached !== undefined) return cached

  let id = readPersistedId(file)
  if (id === undefined) {
    const generate = options.randomUUID ?? randomUUID
    const created = generate() as AnonymousUserId
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${created}\n`, { encoding: 'utf8', flag: 'wx' })
      id = created
    } catch {
      // A wx refusal (EEXIST) covers both a concurrent winner and a
      // pre-existing corrupt file: the reread adopts a valid winner, and an
      // invalid reread falls through to the overwrite path. Non-EEXIST
      // failures (read-only home) land there too, accepted best-effort below.
      id = readPersistedId(file)
      if (id === undefined) {
        try {
          writeFileSync(file, `${created}\n`, 'utf8')
        } catch (_homeUnwritable) {
          // An unwritable home only loses persistence: the fresh id stays in
          // memory, so this run still reports a consistent id.
        }
        id = created
      }
    }
  }
  memo.set(file, id)
  return id
}
