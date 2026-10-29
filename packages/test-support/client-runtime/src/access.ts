/**
 * Static access for client specs. Production pages receive the
 * `remoteAccess` Client service and the global-resource `useRemoteAccess` Hook
 * from the remote-access Client plugin, and the Session and Workspace access
 * Hooks (Session-scope `useAccess`, `useSessionAccess`, `useWorkspaceAccess`)
 * from ui-session and ui-workspace over that service. The test runtimes
 * install an allow-all service and `useRemoteAccess` Hook instead, and
 * hand-built component props spread {@link allowAllAccess}; a spec of a
 * refused path overrides one Hook or provides a {@link StaticRemoteAccess}
 * that refuses the action.
 * @module @deepseek-ai/dsh-client-test-runtime/src/access
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { AccessEffect, ClientRemoteAccess, RemoteEndpoint, TypertResourceKind } from '@deepseek-ai/dsh-api-remote-access/client'
import type { GlobalStandardProps, HostObservable, SessionStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'

/** The access Hooks every Slot component receives. */
export type AccessStandardProps =
  & Pick<GlobalStandardProps, 'useRemoteAccess' | 'useSessionAccess' | 'useWorkspaceAccess'>
  & Pick<SessionStandardProps, 'useAccess'>

/** Access Hooks that allow every action on every resource, for hand-built component props. */
export const allowAllAccess: AccessStandardProps = {
  useRemoteAccess: () => true,
  useAccess: () => true,
  useSessionAccess: () => true,
  useWorkspaceAccess: () => true,
}

const ALLOWED: HostObservable<boolean> = { getSnapshot: () => true, subscribe: () => () => {} }
const REFUSED: HostObservable<boolean> = { getSnapshot: () => false, subscribe: () => () => {} }

/**
 * A `remoteAccess` Client service whose answers never change: `allows`
 * decides each action on every resource once. `whenAccess` installs an
 * allowed action's effects in the caller's fiber at once and never installs a
 * refused action's effects.
 */
export class StaticRemoteAccess extends Service implements ClientRemoteAccess {
  /**
   * @param ctx - Context the service is provided on.
   * @param allows - the fixed answer for each action; allows everything when omitted.
   */
  constructor(ctx: Context, private readonly allows: (action: string) => boolean = () => true) {
    super(ctx, 'remoteAccess')
  }

  source(_kind: TypertResourceKind, _id: string, action: string): HostObservable<boolean> {
    return this.allows(action) ? ALLOWED : REFUSED
  }

  // Prototype methods: the Cordis service proxy binds `this.ctx` to the caller's Context.
  whenAccess(action: RemoteEndpoint, callback: () => AccessEffect): () => void {
    if (!this.allows(action)) return () => {}
    const dispose = this.ctx.effect(callback, `remoteAccess.whenAccess(${JSON.stringify(action)})`)
    return () => { void dispose() }
  }

  whenResourceAccess(_kind: TypertResourceKind, _id: string, action: RemoteEndpoint, callback: () => AccessEffect): () => void {
    return this.whenAccess(action, callback)
  }
}

/** The plugin shape {@link staticAccessPlugin} returns. */
export interface StaticAccessPlugin {
  readonly name: string
  readonly inject: readonly string[]
  apply(ctx: Context): void
}

/**
 * Plugin standing in for the remote-access Client row with fixed answers: it
 * provides a {@link StaticRemoteAccess}, so ui-session and ui-workspace
 * publish their resource Hooks over it, and the matching `useRemoteAccess`
 * Hook on the global resource.
 * @param allows - the fixed answer for each action on every resource.
 * @returns the plugin.
 */
export function staticAccessPlugin(allows: (action: string) => boolean): StaticAccessPlugin {
  return {
    name: 'client-test-runtime:static-access',
    inject: ['slots'],
    apply(ctx: Context): void {
      new StaticRemoteAccess(ctx, allows)
      ctx.slots.provideRoot({ keyedHooks: { remoteAccess: (action: string) => (allows(action) ? ALLOWED : REFUSED) } })
    },
  }
}

/** {@link staticAccessPlugin} allowing every action on every resource. */
export const allowAllAccessPlugin: StaticAccessPlugin = staticAccessPlugin(() => true)
