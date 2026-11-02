/**
 * The reader page's own answer for a workspace-file address a share cannot open.
 *
 * The viewer renders the shipped right Sidebar, which resolves every address through its tab-type
 * registry and refuses one no type claims. A share hands over workspace paths, not file contents, so
 * this page claims `dsh-resource://file/**` itself and says so in the tab: the address is answered by
 * the page that owns the fact, not by Chat's call site.
 *
 * The Liveshare client face mounts this module only on a viewer page.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/client/viewer-share-path
 */

import type { ReactNode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { NS } from './locales.ts'
import css from './viewer-share-path.module.css'

export const name = 'liveshare-viewer-share-path'

/** The tab-type registry and the slot ledger; the parent face registers this page's copy. */
export const inject: readonly string[] = ['slots', 'sidebarRightTabs']

/** This implementation's identity in the tab system; also the key its body registers under. */
const SHARE_PATH_ID = '@deepseek-ai/dsh-experimental-liveshare/viewer-share-path'

/** The tab kind this page owns. */
const SHARE_PATH_KIND = 'liveshare-share-path'

/* jscpd:ignore-start -- the address-basename rule is restated here rather than imported: a feature
 * plugin reaches another plugin's behavior through services and slots, never through its values. */
/**
 * The chip text for one `file:` address: its decoded basename.
 *
 * Decoded per segment, the way the address was built, so a name carrying `#`, `?`, or a space reads
 * as itself.
 * @param address - a `file:`-shaped address.
 * @returns the decoded last path segment, or the address itself when it has none.
 */
function basenameOf(address: string): string {
  const name = address.slice(address.lastIndexOf('/') + 1)
  if (name === '') return address
  try {
    return decodeURIComponent(name)
  } catch {
    // A malformed percent sequence is still a name; showing it raw beats refusing the address.
    return name
  }
}
/* jscpd:ignore-end */

/**
 * The type this page claims workspace-file addresses with.
 *
 * The `builtin` band keeps this page's own answer behind a real file viewer an extension could add
 * later, while still outranking the plain-text fallback ui-sidebar-documentpreview ships.
 * @returns the definition to register.
 */
function sharePathDefinition(): SidebarRightTabDefinition {
  return {
    id: SHARE_PATH_ID,
    kind: SHARE_PATH_KIND,
    patterns: ['dsh-resource://file/**'],
    priority: 'builtin',
    title: basenameOf,
  }
}

/** The body's composed props: the tab it draws and this page's copy. */
export type ViewerSharePathBodyProps =
  PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'liveshare'>

/**
 * State why this page cannot show the file the reader asked for.
 * @param props - the tab's framework share and this page's locale seat.
 * @returns the notice body.
 */
export function ViewerSharePathBody({ useTabInfo, t }: ViewerSharePathBodyProps): ReactNode {
  // Reading the occurrence keeps the body bound to the tab it was dispatched for; the address is
  // the content identity and needs no second store.
  const { tab } = useTabInfo()
  return (
    <p className={css.unavailable} data-liveshare-share-path={tab.contentId}>
      {t('viewer.sharePath.unavailable')}
    </p>
  )
}

/**
 * Claim workspace-file addresses on the reader's page and answer them in place.
 * @param ctx - browser context of the viewer's module table.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.sidebarRightTabs.register(sharePathDefinition()), 'liveshare: viewer share-path type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: SHARE_PATH_ID, locale: NS },
    ViewerSharePathBody,
  )), 'liveshare: viewer share-path tab body')
}
