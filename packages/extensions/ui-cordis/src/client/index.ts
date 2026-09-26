/** Cordis dynamic-plugin cards, inventory panel, business-view host. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from './events.ts'
import { CordisActionRow } from './CordisActionRow.tsx'
import { CordisDefineRow } from './CordisDefineRow.tsx'
import { CordisRunRow } from './CordisRunRow.tsx'
import { CordisPanel } from './CordisPanel.tsx'
import { createCordisInventory } from './inventory.ts'
import { CordisRunCardRegistry } from './run-card-index.ts'
import type { CordisDynamicPort } from './dynamic-port.ts'
import type { CordisCardFace, CordisPanelFace, CordisRunCardFace } from './slots.ts'
import { en, NS, zh } from './locales.ts'

export type { CordisCardFace, CordisPanelFace, CordisRunCardFace, CordisToolViewOwnerProps } from './slots.ts'
export type { CordisActionResult, CordisDynamicPort, CordisInventoryRow } from './dynamic-port.ts'
export type { CordisDefineRowProps } from './CordisDefineRow.tsx'
export type { CordisActionRowProps } from './CordisActionRow.tsx'
export type { CordisRunRowProps } from './CordisRunRow.tsx'
export type {
  CordisRunCardPointer, CordisRunCardStore, CordisToolViewKey,
} from './run-card-index.ts'
export type {
  ApprovalRequestId, CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId,
  DynamicCordisInventoryRow, DynamicCordisPackage, DynamicCordisRetracted,
} from './events.ts'
export type { CordisKey } from './locales.ts'

/** Required services for historical cards, the panel, and Remote lifecycle actions. */
export const inject = [
  'slots', 'locale', 'remote', 'remote.dynamicCordisRunner', 'dynamicCordisRunner',
]

/** Mount every Cordis browser surface over the shared Host inventory. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-cordis: dictionaries')

  const port: CordisDynamicPort = {
    stop: async (sessionId, pluginId) => {
      const answered = await ctx.remote.dynamicCordisRunner.stopFromPanel(sessionId, pluginId)
      if (!answered.ok) return { ok: false, message: `${answered.error.code}: ${answered.error.message}` }
      if (answered.value.ok || answered.value.reason === 'not-running') return { ok: true }
      return { ok: false, message: answered.value.message }
    },
    remove: async (sessionId, pluginId) => {
      const answered = await ctx.remote.dynamicCordisRunner.undefineFromPanel(sessionId, pluginId)
      if (!answered.ok) return { ok: false, message: `${answered.error.code}: ${answered.error.message}` }
      return answered.value.ok ? { ok: true } : { ok: false, message: answered.value.message }
    },
    inventory: async () => {
      const answered = await ctx.remote.dynamicCordisRunner.inventory()
      if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
      return answered.value
    },
  }
  const inventory = createCordisInventory(port, (error) => {
    console.error('[ui-cordis] reading the Cordis inventory failed:', error)
  })
  const runner = ctx.dynamicCordisRunner
  const loaded = { getSnapshot: () => runner.getSnapshot(), subscribe: (fn: () => void) => runner.subscribe(fn) }
  const runCards = new CordisRunCardRegistry()

  ctx.effect(() => inventory.subscribe(() => {
    const snapshot = inventory.getSnapshot()
    if (snapshot.read) runner.reconcileApprovals(snapshot.rows)
  }), 'ui-cordis: reconcile pending approvals')

  ctx.remote.$on('cordis/dynamic-package', () => { inventory.refresh() })
  ctx.remote.$on('cordis/dynamic-retract', () => { inventory.refresh() })
  ctx.remote.$on('cordis/request-run', (request) => {
    if (!inventory.getSnapshot().rows.some(row => row.pluginId === request.pluginId)) inventory.refresh()
  })
  ctx.remote.$on('cordis/request-run-resolved', () => { inventory.refresh() })
  ctx.on('connection/reset', () => {
    inventory.reset()
    inventory.refresh()
  })

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'cordis-panel',
    locale: NS,
    inject: (): CordisPanelFace => ({
      hooks: {
        inventory,
        activeRuns: runner.activeRuns,
        runErrors: runner.lastRunError,
        loaded,
        renderFailures: runner.renderFailures,
      },
      onApprove: (requestId, approveFutureVersions) => runner.approve(requestId, approveFutureVersions),
      onDecline: requestId => runner.decline(requestId),
      onRun: request => runner.startUserRun(request),
      onStop: async (sessionId, pluginId) => {
        const result = await port.stop(sessionId, pluginId)
        inventory.refresh()
        return result
      },
      onRemove: async (sessionId, pluginId) => {
        const result = await port.remove(sessionId, pluginId)
        if (result.ok) inventory.retire(pluginId)
        inventory.refresh()
        return result
      },
      onRefresh: () => { inventory.refresh() },
    }),
  }, CordisPanel))

  const cardFace = (): CordisCardFace => ({ hooks: { inventory, loaded } })
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'cordis_define',
    locale: NS,
    inject: cardFace,
  }, CordisDefineRow))

  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'cordis_run',
    locale: NS,
    children: { 'tool.view.cordis': { kind: 'keyed', scope: 'session' } },
    inject: (sessionId: SessionId): CordisRunCardFace => {
      const store = runCards.forSession(sessionId)
      return {
        hooks: { inventory, loaded, runCards: store, activeRuns: runner.activeRuns },
        onObserveRunCard: (pointer) => { store.observe(pointer) },
      }
    },
  }, CordisRunRow))

  ctx.slots.inject('tool.call.toolview', function* () {
    yield ctx.slots.register({
      name: 'tool.call.toolview', key: 'cordis_stop', locale: NS,
    }, CordisActionRow)
    yield ctx.slots.register({
      name: 'tool.call.toolview', key: 'cordis_undefine', locale: NS,
    }, CordisActionRow)
  })

  inventory.refresh()
}
