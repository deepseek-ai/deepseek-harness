/**
 * The docking kit's vocabulary, in the product's language.
 *
 * The kit renders no string of its own, so every word a user reads inside it is
 * handed over from here. This is a projection of the dictionary, not a second
 * home for copy: the strings live in `locales.ts`.
 */
import type { DockLabels } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'

/**
 * Project the dictionary into the kit's label contract.
 *
 * Called during render, so a language change reaches the kit with the next one —
 * the kit caches no copy to invalidate.
 * @param t - namespace-bound translate.
 * @returns every string the kit renders.
 */
export function dockLabels(t: TranslateNS<'sidebarRight'>): DockLabels {
  return {
    emptyPane: t('dock.emptyPane'),
    splitPane: t('dock.splitPane'),
    splitPaneDisabled: t('dock.splitPaneDisabled'),
    splitPaneNarrow: t('dock.splitPaneNarrow'),
    closeTab: t('dock.closeTab'),
    addTab: t('dock.addTab'),
    dockFloat: t('dock.dockFloat'),
    closeFloat: t('dock.closeFloat'),
    dropZone: {
      center: t('dock.drop.center'),
      left: t('dock.drop.left'),
      right: t('dock.drop.right'),
      top: t('dock.drop.top'),
      bottom: t('dock.drop.bottom'),
    },
  }
}
