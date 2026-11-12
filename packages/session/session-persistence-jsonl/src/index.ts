/** SQLite Session persistence with import-on-open for historical JSONL files. @module */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { JsonlReader, DEFAULT_LIST_CONCURRENCY } from './reader.ts'
import { SEGMENT_STORAGE_DEFAULTS, TracePersistence } from './trace/index.ts'
import type { SegmentStorageConfig } from './trace/index.ts'
import type { JsonlCompression } from './format.ts'
export type { SegmentStorageConfig } from './trace/index.ts'
export type { JsonlCompression } from './format.ts'

const DEFAULT_COMPRESSION: JsonlCompression = 'zstd'
/** Loader schema for the JSONL artifact's physical encoding. */
export const JsonlCompressionSchema: z<JsonlCompression> = z.union([
  z.const('zstd'),
  z.const('none'),
]).default(DEFAULT_COMPRESSION)

/** Session persistence settings and the encoding of historical JSONL files. */
export interface Config {
  /** SQLite database location and write scheduling. */
  segmentStorage?: SegmentStorageConfig
  /**
   * Root directory for all session files. Required (no default): a default of
   * `process.cwd()` would scatter session files as the process's cwd changes
   * (bash calls, subprocesses). Sessions group under human-readable project
   * directories, then per-session directories. An existing root must be a
   * readable directory; an absent root is created when storage first needs a durable directory.
   */
  root: string
  /** Physical encoding; defaults to checksummed Zstandard frames. */
  compression?: JsonlCompression
  /**
   * Maximum directory, header, routing record, and stat reads in flight across
   * all concurrent listings of this backend (`list()`, the root encoding check, and historical
   * fingerprints). Defaults to 3.
   */
  listConcurrency?: number
}

/** JSONL persistence plugin label. */
export const name = 'session-persistence-jsonl'

/** Loader schema for the backend's root, physical encoding, and listing concurrency. */
export const Config: z<Config> = z.object({
  root: z.string().required(),
  segmentStorage: z.object({ path: z.string(),
    busyTimeoutMs: z.natural().default(SEGMENT_STORAGE_DEFAULTS.busyTimeoutMs),
    flushDelayMs: z.natural().min(1).default(SEGMENT_STORAGE_DEFAULTS.flushDelayMs),
    maxBufferedEvents: z.natural().min(1).default(SEGMENT_STORAGE_DEFAULTS.maxBufferedEvents) }),
  compression: JsonlCompressionSchema,
  listConcurrency: z.natural().min(1).default(DEFAULT_LIST_CONCURRENCY),
})

/**
 * Mount persistence with live routing and handles retained through the
 * consumer unloads triggered by removing this provider. Consumers must own
 * cleanup in their injecting scope; concurrent root disposal is not ordered.
 * @param ctx - the owning plugin context.
 * @param config - the storage root, physical encoding, and listing concurrency.
 * @returns resolves when the service is ready.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  let service!: Fiber
  // Keep this generator synchronous so thenable disposers are registered as functions, not awaited.
  ctx.effect(function* () {
    const segments = ctx.plugin({ name: 'session-segment-resources', apply() {} })
    yield segments.dispose
    service = ctx.plugin({
      name: 'session-persistence-jsonl-service',
      async apply(serviceCtx: Context) {
        const instance = new TracePersistence(serviceCtx, segments.ctx, config.root,
          new JsonlReader(serviceCtx, config), config.segmentStorage)
        await instance.start()
      },
    })
    yield service.dispose
  }, 'session-persistence-jsonl resources')
  await service.await()
}
