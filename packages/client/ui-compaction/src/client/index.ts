/** Navigate to a durable summary rendered by the shared Markdown document body. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { SessionAddress } from '@deepseek-ai/dsh-api-session-controller/types'
import { en, ja, es, fr, de, ru, pt, zh } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { summaryAddress, parseSummaryAddress } from './summary.ts'
import { summaryResourceProvider } from './resource.ts'
import { SummaryPreview, SummaryTitle } from './SummaryPreview.tsx'

export type { CompactionKey } from './locales.ts'

/** Summary preview navigation. */
export interface CompactionPreviews {
  /**
   * Open the recorded summary unless the requesting row has been cancelled.
   * @param address - complete history address.
   * @param summarySeq - compaction/summary event sequence.
   * @param signal - requesting row lifetime.
   * @returns null after navigation or cancellation. The tab reports history read failures.
   */
  open(address: SessionAddress, summarySeq: number, signal: AbortSignal): Promise<string | null>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Available while document previews are loaded. */
    compactionPreviews: CompactionPreviews
  }
}

/** Services required to read summary text. */
export const inject = ['locale', 'remote', 'remote.session', 'resources', 'sidebarRight', 'sidebarRightTabs', 'slots']

/** @param ctx - browser context with Session history and locale services. */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind('compaction')
  ctx.effect(() => ctx.locale.register('compaction', { zh, en, ja, es, fr, de, ru, pt }), 'ui-compaction: dictionaries')
  ctx.effect(() => ctx.resources.register(summaryResourceProvider(ctx.remote.session)), 'ui-compaction: summary resources')
  ctx.inject(['documentPreviews'], (scope) => {
    const lifetime = new AbortController()
    scope.effect(() => () => { lifetime.abort() }, 'ui-compaction: navigation lifetime')
    const id = '@deepseek-ai/dsh-client-ui-compaction'
    scope.effect(() => scope.sidebarRightTabs.register({
      id, kind: 'compaction', patterns: ['dsh-resource://compaction/**'], priority: 'builtin',
      canOpen: address => parseSummaryAddress(address) !== undefined,
      title: () => t('preview.title'),
    }), 'ui-compaction: summary tab')
    scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab', key: id, locale: 'compaction',
    }, SummaryPreview))
    scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register({
      name: 'sidebar.right.pane.tab.title', key: id, locale: 'compaction',
    }, SummaryTitle))
    const service: CompactionPreviews = {
      open(address, summarySeq, signal) {
        if (!signal.aborted && !lifetime.signal.aborted) {
          scope.sidebarRight.openResource(summaryAddress({ session: address, seq: SessionSeq(summarySeq) }))
        }
        return Promise.resolve(null)
      },
    }
    const dispose = scope.reflect.provide('compactionPreviews', service)
    scope.effect(() => dispose, 'ui-compaction: preview service')
  })
}
