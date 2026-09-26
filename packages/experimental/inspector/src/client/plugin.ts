/** Client Cordis plugin that publishes browser observations directly to the Inspector Worker. */

import type { Context } from '@deepseek-ai/cordis'
import { parseInspectorClientBootstrap } from '../shared/bridge/control-codec.ts'
import { createInspectorService, type InspectorService as SharedInspectorService } from '../shared/service.ts'
import { publishCordisTree } from './inspection/cordis.ts'
import { startInspectorClient } from './bridge/controller.ts'

export type { CordisRuntimeTreeReader } from '../shared/cordis/reader.ts'
export type {
  CordisRuntimeConnection,
  CordisRuntimeContext,
  CordisRuntimeFiber,
  CordisRuntimeNode,
  CordisRuntimeRealm,
  CordisRuntimeSource,
  CordisRuntimeTree,
} from '../shared/cordis/model.ts'

/** Client-facing Inspector service backed by the shared implementation. */
export interface InspectorService extends SharedInspectorService {}

declare global {
  /** Host-injected Inspector Client connection parameters. */
  var __DSH_INSPECTOR__: unknown
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Publish Client-realm observations and query the shared Inspector state. */
    inspector: InspectorService
  }
}

/** Cordis plugin name shared with the Host face. */
export const name = 'experimental-inspector'

/** This transport root has no Client service dependencies. */
export const inject: string[] = []

/**
 * Mount the Client source and shared `ctx.inspector` publishing API.
 * @param ctx - Client Cordis context whose page identity and lifecycle own the source.
 */
export async function apply(ctx: Context): Promise<void> {
  const injected = globalThis.__DSH_INSPECTOR__
  if (injected === undefined) {
    throw new Error('experimental inspector: Host bootstrap is missing; reload the page after enabling the Inspector')
  }
  const bootstrap = parseInspectorClientBootstrap(injected)
  await ctx.effect(async () => {
    const source = await startInspectorClient(bootstrap)
    const disposers: Array<() => unknown> = []
    try {
      disposers.push(publishCordisTree(ctx, source, {
        maxNodes: bootstrap.maxCordisNodes,
        maxBytes: bootstrap.maxFrameBytes - 4_096,
      }))
      disposers.push(ctx.provide('inspector', createInspectorService(source)))
    } catch (error) {
      try {
        disposeInspectorClient(source, disposers)
      } catch (cleanupError) {
        ctx.logger.error('experimental-inspector: Client initialization rollback failed', cleanupError)
      }
      throw error
    }
    return () => { disposeInspectorClient(source, disposers) }
  }, 'experimental-inspector: Client source')
}

function disposeInspectorClient(
  source: Awaited<ReturnType<typeof startInspectorClient>>,
  disposers: readonly (() => unknown)[],
): void {
  const failures: unknown[] = []
  for (const dispose of [...disposers].reverse()) {
    try {
      dispose()
    } catch (error) {
      failures.push(error)
    }
  }
  try {
    source.close()
  } catch (error) {
    failures.push(error)
  }
  if (failures.length > 0) throw new AggregateError(failures, 'experimental-inspector: Client disposal failed')
}
