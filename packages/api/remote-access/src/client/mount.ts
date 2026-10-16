/**
 * Client access mount: follows the calling Peer's access snapshot, provides
 * the `remoteAccess` Client service, and publishes the global-resource `useRemoteAccess` Hook.
 * The entry module supplies the generated `remoteAccess` contribution, so
 * specs mount a fake one.
 * @module @deepseek-ai/dsh-api-remote-access/src/client/mount
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import {
  RemoteSnapshotStream,
  RemoteStreamCarrierError,
  type ClientRemote,
} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-remote-access/remote'
import type { HostObservable, RootStandardSourceContribution } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the SlotRegistry (`ctx.slots`) merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { TypertRemoteContribution, TypertRemoteMap, TypertResourceKind } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteAccessFrame } from '../types.ts'
import { ClientAccessState, type Baseline } from './state.ts'

/** Every endpoint the Client Remote namespaces declare. */
export type RemoteEndpoint = Extract<keyof TypertRemoteMap, string>

/** Client access answers over the calling Peer's snapshot; it never issues a request. */
export interface ClientRemoteAccess {
  /**
   * Whether the current Peer may call `action` on one resource.
   * True for the owner; false without a baseline and after a non-owner
   * stream fails; otherwise whether the resource's grant lists the action.
   * @param kind - resource kind declared in `TypertResourceMap`.
   * @param id - resource identity.
   * @param action - endpoint action the caller would invoke.
   * @returns identity-stable boolean source for this `(kind, id, action)`.
   */
  source(kind: TypertResourceKind, id: string, action: string): HostObservable<boolean>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Client access answers for the calling Peer. */
    remoteAccess: ClientRemoteAccess
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface GlobalStandardProps {
    /** Whether the current Peer may call `action` on the global resource. */
    useRemoteAccess: (action: RemoteEndpoint) => boolean
  }
}

type IncrementFrame = Exclude<RemoteAccessFrame, { type: 'baseline' }>

/** The `remoteAccess` Client service over one snapshot owner. */
class ClientRemoteAccessService extends Service implements ClientRemoteAccess {
  /**
   * @param ctx - Client Context the service is provided on.
   * @param state - snapshot owner answering every source.
   */
  constructor(ctx: Context, private readonly state: ClientAccessState) {
    super(ctx, 'remoteAccess')
  }

  source(kind: TypertResourceKind, id: string, action: string): HostObservable<boolean> {
    return this.state.resource(kind, id, action)
  }
}

/**
 * Mount the `remoteAccess` namespace, follow the access snapshot, provide the
 * `remoteAccess` Client service, and publish the global-resource `useRemoteAccess` Hook.
 * Answers start from the page's injected baseline, or false without one,
 * and follow the stream's frames from then on.
 * @param ctx - Client root Context injecting `remote` and `slots`.
 * @param contribution - generated `remoteAccess` Remote contribution.
 * @param initial - the page's injected opening baseline, read before the stream connects.
 * @returns disposer that withdraws the namespace after the stream stops.
 */
export async function mountAccess(
  ctx: Context,
  contribution: TypertRemoteContribution,
  initial?: Baseline,
): Promise<() => Promise<void>> {
  const state = new ClientAccessState(initial)
  new ClientRemoteAccessService(ctx, state)
  ctx.slots.provideRoot({
    keyedHooks: { remoteAccess: action => state.global(action) },
  } satisfies RootStandardSourceContribution)
  const unmount = await ctx.remote.$mount(contribution)
  const follow = ctx.inject(['remote.remoteAccess'], (remoteCtx) => {
    const control = createAccessStream(remoteCtx.remote, state, remoteCtx.logger)
    control.start()
    remoteCtx.effect(() => async () => { await control.dispose() }, 'remote-access.client.follow')
  })
  return async () => {
    await follow.dispose()
    await unmount()
  }
}

/**
 * Create the reconnecting access snapshot stream. A carrier loss keeps the
 * last snapshot while the stream reconnects; a terminal failure keeps the
 * owner's answers and turns a non-owner's answers false.
 */
function createAccessStream(
  remote: ClientRemote,
  state: ClientAccessState,
  logger: Context['logger'],
): RemoteSnapshotStream<Baseline, IncrementFrame> {
  const stream = remote.$stream<RemoteAccessFrame>({
    name: 'Remote access stream',
    open: signal => remote.remoteAccess.follow(signal),
    ended: accepted => accepted
      ? new RemoteStreamCarrierError('Remote access stream ended without a terminal result')
      : new Error('Remote access stream ended before its opening snapshot'),
  })
  return new RemoteSnapshotStream<Baseline, IncrementFrame>(stream, {
    name: 'Remote access stream',
    isSnapshot: (frame): frame is Baseline => frame.type === 'baseline',
    replace: (frame) => { state.replace(frame) },
    update: (frame) => { state.update(frame) },
    failed: (error) => {
      // Only a non-owner's answers turn false after a terminal failure, so only its report names the recovery.
      if (state.owner) logger.error('access snapshot stream failed; owner access answers are unaffected', error)
      else logger.error('access snapshot stream failed; reload the page to reconnect', error)
      state.unavailable()
    },
  })
}
