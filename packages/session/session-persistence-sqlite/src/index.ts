/** SQLite Session persistence and event storage. @module */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { Config as JsonlConfig, JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { Config as JsonlConfigOptions } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SqliteSessionPersistence } from './persistence.ts'

/** Loader label for the SQLite Session persistence provider. */
export const name = 'session-persistence-sqlite'

/** Storage root and JSONL settings used when importing legacy Sessions. */
export type Config = JsonlConfigOptions

/** Validate the storage root and legacy JSONL reader settings. */
export const Config = JsonlConfig

/**
 * Provide SQLite persistence and retain storage resources through consumer unload.
 * @param ctx - plugin context owning the provider and its resources.
 * @param config - storage root and legacy JSONL reader settings.
 * @returns resolves after the persistence service is registered.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  let service!: Fiber
  ctx.effect(function* () {
    const resources = ctx.plugin({ name: 'session-segment-resources', apply() {} })
    yield resources.dispose
    service = ctx.plugin({
      name: 'session-persistence-sqlite-service',
      apply(serviceCtx: Context) {
        const legacy = new JsonlSessionPersistence(serviceCtx.isolate('sessionPersistence'), config)
        new SqliteSessionPersistence(serviceCtx, resources.ctx, config, legacy)
      },
    })
    yield service.dispose
  }, 'session-persistence-sqlite resources')
  await service.await()
}
