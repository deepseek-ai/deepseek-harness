/**
 * Desktop Office native preview mount. The entry module supplies the generated
 * `officePreview` Remote contribution, so specs mount a fake one.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-frame-forwarding/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import { OfficePreviewClient } from './service.ts'
import { PresentationAction } from './PresentationAction.tsx'
import { createPresentationStore } from './presentation-store.ts'
import { Preview } from './Preview.tsx'
import { RetainedViews } from './RetainedViews.tsx'
import { zh, en, ja, es, fr, de, ru, pt } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  interface LocaleNamespaceMap {
    /** Default Office preview controls. */ desktopOffice: import('./locales.ts').OfficeKey
  }
}
/** Default preview services; native rendering additionally needs the renderer-side `frameForwarding` service. */
export const inject = ['remote', 'slots', 'locale']

function unwrap<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/**
 * Register native preview in a document with frame forwarding whose Host renders this workspace locally; others keep
 * the existing preview.
 */
async function register(ctx: Context): Promise<void> {
  const frames = ctx.frameForwarding
  const availability = await ctx.remote.officePreview.availability()
  // Switching the bundle off withdraws the Host's Office service while this call can still be in flight; this scope
  // ends with it, so nothing registers.
  if (!availability.ok && availability.error.code === 'gateway/definition-unavailable') return
  if (!unwrap(availability).local) return
  const office = new OfficePreviewClient(ctx, frames)
  const presentationStore = createPresentationStore()
  ctx.effect(() => ctx.locale.register('desktopOffice', { zh, en, ja, es, fr, de, ru, pt }))
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'office.retained-views', inject: () => ({ hooks: { views: office.views } }),
  }, RetainedViews)))
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document.office.native', () => ctx.slots.register({
    name: 'sidebar.right.tab.document.office.native',
    locale: 'desktopOffice', store: presentationStore, inject: () => ({ office }),
  }, Preview)))
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document.office.native.action', () => ctx.slots.register({
    name: 'sidebar.right.tab.document.office.native.action',
    locale: 'desktopOffice', store: presentationStore,
  }, PresentationAction)))
}

/** Mount the Office Remote contribution and register native presentation inside the existing document preview.
 * @param ctx - Desktop Client plugin scope.
 * @param contribution - Generated `officePreview` Remote contribution.
 * @returns Disposer withdrawing the UI before its Remote contribution.
 */
export async function mountOfficePreview(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const remote = ctx.plugin(scope => scope.remote.$mount(contribution))
  const ui = ctx.inject(['remote.officePreview', 'frameForwarding', ...inject.slice(1)], async (scope) => {
    await remote
    await register(scope)
  })
  // An async generator would unwrap these thenable disposers and leave the originals on the parent fiber.
  const dispose = ctx.effect(function* () {
    yield remote.dispose
    yield ui.dispose
  })
  try { await Promise.all([remote, ui]) } catch (error) { await dispose(); throw error }
  return async () => { await dispose() }
}
