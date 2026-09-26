/** Static Browser tab type and guide declaration. */
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { GuideArtworkBrowser } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from './locales.ts'

/** Browser tab kind. */
export const BROWSER_KIND = 'browser'

/** Browser implementation identity and keyed Slot dispatch key. */
export const BROWSER_ID = '@deepseek-ai/dsh-client-ui-sidebar-browser'

/** Build the Browser type with locale-live copy. */
export function browserDefinition(t: TranslateNS<'sidebarBrowser'>): SidebarRightTabDefinition {
  return {
    id: BROWSER_ID,
    kind: BROWSER_KIND,
    multiple: true,
    priority: 'builtin',
    title: () => t('type.label'),
    guide: [{
      id: 'new', commandId: 'browser.new' as ShortcutCommandId, order: 30, title: () => t('guide.title'),
      description: () => t('guide.description'), icon: GuideArtworkBrowser,
    }],
  }
}
