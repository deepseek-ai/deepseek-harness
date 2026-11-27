/** SQLite Session persistence and event storage. @module */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { JsonlCompressionSchema, JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { Config as JsonlConfigOptions } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SqliteSessionPersistence } from './persistence.ts'
import type { Recovery } from './sqlite.ts'

/** Loader label for the SQLite Session persistence provider. */
export const name = 'session-persistence-sqlite'

/** Storage root, the JSONL settings used when importing legacy Sessions, and the database recovery mode. */
export type Config = JsonlConfigOptions & {
  /** What an open does when the database cannot be used; see {@link Recovery}. */
  recovery?: Recovery
  /** Days without an open or append before archiving an idle Session, or `0` to disable archiving. Defaults to `30`. */
  coldAfterDays?: number
}

/** Validate the storage root, legacy JSONL reader settings, and recovery mode. */
export const Config: z<Config> = z.object({
  root: z.string().required(),
  compression: JsonlCompressionSchema,
  listConcurrency: z.natural().min(1).default(3),
  recovery: z.union([z.const('replace'), z.const('report')]).default('replace'),
  coldAfterDays: z.natural().max(36500).default(30),
})

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
