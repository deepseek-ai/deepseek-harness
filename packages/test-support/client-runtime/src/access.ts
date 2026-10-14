/**
 * Allow-all access for client specs. Production pages receive the
 * `remoteAccess` Client service and the global-resource `useRemoteAccess` Hook
 * from the remote-access Client plugin, and the Session and Workspace access
 * Hooks (Session-scope `useAccess`, `useSessionAccess`, `useWorkspaceAccess`)
 * from ui-session and ui-workspace over that service. The test runtimes
 * install an allow-all service and `useRemoteAccess` Hook instead, and
 * hand-built component props spread {@link allowAllAccess}; a spec of a
 * refused path overrides one Hook.
 * @module @deepseek-ai/dsh-client-test-runtime/src/access
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ClientRemoteAccess } from '@deepseek-ai/dsh-api-remote-access/client'
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
const allowed = (): HostObservable<boolean> => ALLOWED

/** The `remoteAccess` Client service answering true for every resource. */
const allowAllRemoteAccess: ClientRemoteAccess = { source: allowed }

/**
 * Plugin standing in for the remote-access Client row: it provides an
 * allow-all `remoteAccess` service, so ui-session and ui-workspace publish
 * their resource Hooks over it, and the allow-all `useRemoteAccess` Hook on
 * the global resource.
 */
export const allowAllAccessPlugin = {
  name: 'client-test-runtime:allow-all-access',
  inject: ['slots'],
  /** @param ctx - plugin Context with the Slot registry injected. */
  apply(ctx: Context): void {
    ctx.provide('remoteAccess', allowAllRemoteAccess)
    ctx.slots.provideRoot({ keyedHooks: { remoteAccess: allowed } })
  },
}
