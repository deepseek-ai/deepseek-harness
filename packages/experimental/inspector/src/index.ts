/** Repository-facing Host package entry over the mirrored implementation tree. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  apply as applyHost,
} from './host/plugin.ts'
import { resolveInspectorOptions, type InspectorOptions } from './host/bridge/controller.ts'
import type { CordisRuntimeTreeReader } from './shared/cordis/reader.ts'
import type { InspectorJsonValue } from './shared/json.ts'

export { resolveInspectorOptions, startInspector } from './host/plugin.ts'
export type { InspectorEndpoint, InspectorHandle, InspectorOptions, InspectorSpec } from './host/plugin.ts'
export type { CordisRuntimeTreeReader } from './shared/cordis/reader.ts'
export type {
  CordisRuntimeConnection,
  CordisRuntimeContext,
  CordisRuntimeFiber,
  CordisRuntimeNode,
  CordisRuntimeRealm,
  CordisRuntimeSource,
  CordisRuntimeTree,
} from './shared/cordis/model.ts'
export type { InspectorClientBootstrap } from './shared/bridge/messages/control.ts'
export type {
  InspectorRecordInput,
  InspectorSourceDescriptor,
  InspectorSourceKind,
} from './shared/bridge/messages/observation.ts'
export type { InspectorJsonObject, InspectorJsonPrimitive, InspectorJsonValue } from './shared/json.ts'
export type {
  CordisContextTreeNode,
  CordisFiberTreeNode,
  CordisTreeNode,
  CordisTreeSnapshot,
} from './shared/cordis/snapshot.ts'

/** Shared Host/Client service façade over the realm's source publisher. */
export interface InspectorService {
  /**
   * Publish one JSON observation without waiting for Worker delivery.
   * @param topic - Domain-owned topic name.
   * @param payload - JSON value validated before it reaches the carrier.
   * @param monotonicMs - Source-clock timestamp; defaults to `performance.now()`.
   */
  publish(topic: string, payload: InspectorJsonValue, monotonicMs?: number): void

  /** Read-only Cordis topology queries independent of CDP sessions. */
  readonly cordis: CordisRuntimeTreeReader
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Publish Host-realm observations and query the shared Inspector state. */
    inspector: InspectorService
  }
}

/** Cordis plugin name shared with the Client face. */
export const name = 'experimental-inspector'

/** Web Host and authenticated browser bootstrap transport. */
export const inject = ['webServer', 'connection']

/** Host plugin configuration. Fetch capture is enabled by default. */
export interface Config extends Omit<InspectorOptions, 'clientOrigins'> {
  /** Browser origins allowed to open the Client ingest WebSocket. */
  clientOrigins?: string[]
}

const libraryDefaults = resolveInspectorOptions()

/** Runtime validation for {@link Config}. */
export const Config: z<Config> = z.object({
  host: z.const('127.0.0.1').default('127.0.0.1'),
  port: z.natural().max(65_535).default(9_230),
  clientOrigins: z.array(z.string()).default([]),
  captureFetch: z.boolean().default(true),
  maxRequestBodyBytes: z.natural().min(1).default(libraryDefaults.maxRequestBodyBytes),
  maxResponseBodyBytes: z.natural().min(1).default(libraryDefaults.maxResponseBodyBytes),
  maxBodyChunkBytes: z.natural().min(1).default(libraryDefaults.maxBodyChunkBytes),
  maxJournalBytes: z.natural().min(1).default(libraryDefaults.maxJournalBytes),
  maxRetainedRequests: z.natural().min(1).default(libraryDefaults.maxRetainedRequests),
  maxSourceFrameBytes: z.natural().min(1).default(libraryDefaults.maxSourceFrameBytes),
  maxSourceRecordsPerFrame: z.natural().min(1).default(libraryDefaults.maxSourceRecordsPerFrame),
  maxQueuedRecords: z.natural().min(1).default(libraryDefaults.maxQueuedRecords),
  maxQueuedBytes: z.natural().min(1).default(libraryDefaults.maxQueuedBytes),
  startupTimeoutMs: z.natural().min(1).default(libraryDefaults.startupTimeoutMs),
  stopTimeoutMs: z.natural().min(1).default(libraryDefaults.stopTimeoutMs),
  clientReconnectBaseMs: z.natural().min(1).default(libraryDefaults.clientReconnectBaseMs),
  clientReconnectMaxMs: z.natural().min(1).default(libraryDefaults.clientReconnectMaxMs),
  clientRuntimeTimeoutMs: z.natural().min(1).default(libraryDefaults.clientRuntimeTimeoutMs),
  queryTimeoutMs: z.natural().min(1).default(libraryDefaults.queryTimeoutMs),
  maxClientRuntimeObjects: z.natural().min(1).default(libraryDefaults.maxClientRuntimeObjects),
  maxClientRuntimeProperties: z.natural().min(1).default(libraryDefaults.maxClientRuntimeProperties),
  maxClientSourceBytes: z.natural().min(1).default(libraryDefaults.maxClientSourceBytes),
  maxCordisNodes: z.natural().min(1).default(libraryDefaults.maxCordisNodes),
  maxDisconnectedCordisTrees: z.natural().default(libraryDefaults.maxDisconnectedCordisTrees),
})

/**
 * Start inspection when enabled; the hidden --inspect flag also opens the Host debugging window.
 * @param ctx - Host Cordis plugin context.
 * @param config - Validated Inspector configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await applyHost(ctx, config)
}
