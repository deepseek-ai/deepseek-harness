/** Native directory flow using the local desktop bridge or the Host's OS chooser. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the remoteAccess service merge (ctx.remoteAccess).
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
// Type-only: pulls the SlotMap merge declaring the directory-flow holes.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { NativeFlowInjected } from './flow.ts'
import { NativeDirectoryFlow } from './flow.ts'


/** Required services (cordis fiber inject): the slot registry, workspace UI service, and access. */
export const inject = ['slots', 'uiWorkspace', 'remoteAccess']

/**
 * Client plugin body: while the current Peer may open the Host's directory
 * chooser, register the renderless native flow into all three directory-flow
 * holes through `slots.inject()` because the ui-workspace declarations may
 * activate later or be replaced.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const desktop = (globalThis as typeof globalThis & {
    __DSH_DIRECTORY_PICKER__?: NativeFlowInjected
  }).__DSH_DIRECTORY_PICKER__
  const pick = desktop === undefined ? () => ctx.uiWorkspace.pickDirectory() : () => desktop.pick()
  const injected = (): NativeFlowInjected => ({ pick })
  // Every declaration lifetime must be live before the set installs; the
  // generator makes the three registrations one transactional effect. The
  // nesting order is arbitrary; no hole has precedence.
  ctx.remoteAccess.whenAccess('directoryPicker/pick', () =>
    ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
      ctx.slots.inject('sidebar.workspaces.directoryFlow', () =>
        ctx.slots.inject('workspace.picker.directoryFlow', function* () {
          yield ctx.slots.register({
            name: 'conversation.hero.workspace.directoryFlow', inject: injected,
          }, NativeDirectoryFlow)
          yield ctx.slots.register({
            name: 'sidebar.workspaces.directoryFlow', inject: injected,
          }, NativeDirectoryFlow)
          yield ctx.slots.register({
            name: 'workspace.picker.directoryFlow', inject: injected,
          }, NativeDirectoryFlow)
        }))))
}
