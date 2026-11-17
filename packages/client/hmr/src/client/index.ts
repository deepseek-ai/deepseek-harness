/** Remote-stream transport for page-owned client entry reconciliation, rebuilt code replacement, and synced configuration. */
import type { Context } from '@deepseek-ai/cordis'
import { RemoteSnapshotStream, RemoteStreamCarrierError, type RemoteStreamCarrierFailure } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-client-modules/client'
// This package mounts its own namespace, so the channel does not depend on the api-remotes assembly being replaceable.
import pluginEventsRemote from '@deepseek-ai/dsh-client-hmr/remote'
import type { PluginsEventBaseline, PluginsEventFrame, PluginsEventIncrement } from '../types.ts'

export type * from '../types.ts'

/** Cordis plugin name. */
export const name = 'client-hmr'

/** Required services: the module system whose entry controller handles frames, the Remote carrier, and Remote access. */
export const inject = ['modules', 'remote', 'remoteAccess']

const CARRIER_LOST: RemoteStreamCarrierFailure['code'] = 'gateway/carrier-lost'
/** Remote failures a Host reload produces while it withdraws `pluginEvents` with the socket still open. */
const RELOADING: ReadonlySet<string> = new Set(['gateway/invocation-unavailable', 'gateway/service-unavailable'])

/**
 * Open one generation, reporting an endpoint the Host has withdrawn while it reloads as a carrier loss, so the stream
 * reconnects instead of ending.
 * @param open - opens the generation's frames.
 * @yields the generation's frames.
 */
async function *reconnectWhileReloading(open: () => AsyncIterable<PluginsEventFrame>): AsyncIterable<PluginsEventFrame> {
  try {
    yield * open()
  } catch (error) {
    if (error instanceof Error && 'code' in error && RELOADING.has(String(error.code))) {
      throw new RemoteStreamCarrierError('Plugin events are unavailable while the Host reloads', { cause: error })
    }
    throw error
  }
}

/** The generated `pluginEvents` client method this plugin calls. */
interface PluginEventsNamespace {
  follow(signal: AbortSignal): AsyncIterable<PluginsEventFrame>
}

/** Receivers of one followed stream. */
interface PluginEventSinks {
  /** A generation's complete graph. */
  readonly baseline: (frame: PluginsEventBaseline) => void
  /** One increment after the baseline. */
  readonly increment: (frame: PluginsEventIncrement) => void
  /** A terminal stream failure; graph changes stop until the page reloads. */
  readonly failed: (error: unknown) => void
}

/**
 * Follow `pluginEvents/follow` as a reconnecting baseline-and-increment stream.
 * @param ctx - context carrying the Remote carrier and the mounted `pluginEvents` namespace.
 * @param sinks - frame receivers.
 * @returns the disposer that stops the stream and waits until no frame can arrive.
 */
function followPluginEvents(ctx: Context, sinks: PluginEventSinks): () => Promise<void> {
  // `$mount` registered the namespace as its own service; only this plugin mounts it, so it is read by name rather
  // than through a declared injection.
  const namespace = ctx.get('remote.pluginEvents') as PluginEventsNamespace | undefined
  if (namespace === undefined) throw new Error('client-hmr: the mounted pluginEvents namespace is not registered')
  const stream = ctx.remote.$stream<PluginsEventFrame>({
    name: 'Plugin events',
    open: signal => reconnectWhileReloading(() => namespace.follow(signal)),
    // A Host-side end (the service restarting) reconnects rather than ending the logical stream.
    ended: (): RemoteStreamCarrierFailure => Object.assign(new Error('Plugin events stream ended'), { code: CARRIER_LOST }),
  })
  const control = new RemoteSnapshotStream<PluginsEventBaseline, PluginsEventIncrement>(stream, {
    name: 'Plugin events',
    isSnapshot: (frame): frame is PluginsEventBaseline => frame.type === 'baseline',
    replace: sinks.baseline,
    update: sinks.increment,
    failed: sinks.failed,
  })
  control.start()
  return () => control.dispose()
}

/**
 * Forward each stream generation's graph and rebuilds to the page's serial entry controller, which also applies each
 * row's synced configuration, while Remote access allows the stream.
 * @param ctx - Plugin context with the client module system and Remote carrier.
 * @returns the disposer of this plugin's `pluginEvents` namespace.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(pluginEventsRemote)
  const entries = ctx.modules.entries
  // A malformed graph throws synchronously from sync(); both paths report through the same rejection.
  const run = (task: () => Promise<void>): void => {
    void Promise.resolve().then(task).catch((error: unknown) => { ctx.logger.error(error) })
  }
  const sinks: PluginEventSinks = {
    baseline: (frame) => { run(() => entries.sync(frame.graph)) },
    increment: (frame) => {
      switch (frame.type) {
        case 'graph':
          run(() => entries.sync(frame.graph))
          break
        case 'rebuilt':
          run(() => entries.reload(frame.id, frame.rev))
          break
        default:
          // Forward compatibility: a newer Host's increment type is ignored.
          break
      }
    },
    failed: (error) => { ctx.logger.error('client-hmr: plugin events stopped; client graph changes stop until the page reloads', error) },
  }
  ctx.remoteAccess.whenAccess('pluginEvents/follow', () => followPluginEvents(ctx, sinks))
  return unmount
}
