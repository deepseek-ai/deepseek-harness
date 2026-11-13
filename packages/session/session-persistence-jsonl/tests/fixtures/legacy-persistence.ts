/** Mount the retained JSONL backend for its existing storage tests. @module */
import { Context } from '@deepseek-ai/cordis'
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
  await persistence.apply(ctx, { ...config, storage: 'jsonl' })
}
