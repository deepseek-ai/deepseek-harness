/**
 * The forge panel's entry in the URL context menu: a change request link that a registered provider serves offers
 * Open in code review, which binds the change request to the Session and opens its changes view in the right sidebar.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { IconFilesDiffOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-experimental-client-ui-forge/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ForgePanelKey } from './locales.ts'

/** Icon key of the menu entry. */
const REVIEW_ICON = 'forge-panel.review'

/** What the menu entry needs from the panel. */
export interface LinkMenuDeps {
  /** Forge panel copy. */
  readonly t: (key: ForgePanelKey) => string
  /** Open the changes view of a change request the Session binds, by its canonical URL. */
  readonly openChanges: (sessionId: SessionId, url: string) => void
}

/**
 * Register the URL menu entry while the context menu service is present. The Host decides whether a URL names a change
 * request, so links on every host a provider serves qualify; any other URL, and a failed or cancelled lookup, adds no
 * entry. Selecting the entry binds the change request, which leaves an existing binding as it is, and then opens its
 * changes view; a refused binding rejects, which the menu reports with the entry's failure label.
 * @param ctx - the forge panel's Client context, with the panel Remote mounted.
 * @param deps - copy and the changes view opener.
 */
export function registerLinkMenu(ctx: Context, deps: LinkMenuDeps): void {
  ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({ name: 'contextMenu.icon', key: REVIEW_ICON }, IconFilesDiffOutlineRegular))
  ctx.inject(['contextMenus'], (scope) => {
    // Before the generic entries ui-open-in-app lists for every URL.
    scope.effect(() => scope.contextMenus.register({
      id: 'forge-panel.url', target: 'url', order: 50,
      resolve: async ({ sessionId, url }, signal) => {
        const recognized = await ctx.remote.forgePanel.recognize(url, signal)
        if (!recognized.ok || recognized.value === null) return []
        const canonical = recognized.value
        return [{
          id: 'review', icon: { key: REVIEW_ICON }, label: deps.t('menu.openInReview'), failureLabel: deps.t('menu.openInReviewFailed'),
          run: async () => {
            const tracked = await ctx.remote.forgePanel.track(sessionId, canonical)
            if (!tracked.ok) throw new Error(tracked.error.message)
            deps.openChanges(sessionId, canonical)
          },
        }]
      },
    }), 'forge-panel: URL context menu')
  })
}
