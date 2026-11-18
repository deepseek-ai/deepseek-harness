/** SQLite Session persistence and event storage. @module */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { JsonlCompressionSchema, JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { Config as JsonlConfigOptions } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SqliteSessionPersistence } from './persistence.ts'

/** Loader label for the SQLite Session persistence provider. */
export const name = 'session-persistence-sqlite'

/**
 * Default events per stored frame. Imported histories reach this cap; a live
 * batch rarely does. Larger frames compress a few percent better and cost
 * proportionally more to decode for a tail read.
 */
const DEFAULT_FRAME_EVENTS = 64

/** Storage root, JSONL settings used when importing legacy Sessions, and the frame size for new writes. */
export interface Config extends JsonlConfigOptions {
  /**
   * Maximum events stored per frame. One frame is the unit of compression and
   * of decoding, so this bounds both the compression ratio and the cost of
   * reading a slice; stored frames keep the size they were written with.
   */
  frameEvents?: number
}

/** Validate the storage root, legacy JSONL reader settings, and frame size. */
export const Config: z<Config> = z.object({
  root: z.string().required(),
  compression: JsonlCompressionSchema,
  listConcurrency: z.natural().min(1).default(3),
  frameEvents: z.natural().min(1).default(DEFAULT_FRAME_EVENTS),
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
