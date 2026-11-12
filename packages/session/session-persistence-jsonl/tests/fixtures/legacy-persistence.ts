/** Mount the retained JSONL backend for its existing storage tests. @module */
import { Context } from '@deepseek-ai/cordis'
import { vi } from 'vitest'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { SqliteLogs } from '@deepseek-ai/dsh-session-persistence-sqlite/src/sqlite.ts'
import { JsonlBackendTracker } from '../../src/storage.ts'
import * as persistence from '../../src/index.ts'
import type { Config } from '../../src/index.ts'

export { Config, JsonlCompressionSchema } from '../../src/index.ts'

/** Test provider label. */
export const name = 'session-persistence-jsonl-legacy-tests'

/**
 * Register the existing JSONL implementation without materializing SQLite.
 * @param ctx - test provider owner.
 * @param config - original JSONL settings.
 * @returns resolves when the JSONL provider and its event routing are available.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const source = ctx.isolate('sessionPersistence')
  const start = vi.spyOn(SqliteLogs.prototype, 'start').mockResolvedValueOnce()
  try { await persistence.apply(source, config) } finally { start.mockRestore() }
  const provider = source.reflect.get('sessionPersistence', false) as SessionPersistence
  const legacy = Reflect.get(provider, 'jsonl') as SessionPersistence
  const tracker = Reflect.get(legacy, 'tracker') as JsonlBackendTracker
  ctx.provide('sessionPersistence', legacy)
  tracker.install(ctx)
}
