/** Composer `@` source and transcript rule for canonical plugin references. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { BundleInfo } from '@deepseek-ai/dsh-api-remotes/client'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { PluginArtworkDefault } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import {
  formatPluginMention, isPluginPackageName, nextPluginMention, packageNameOfPluginMention,
} from '@deepseek-ai/dsh-plugin-manager/grammar'
import { localizedValues } from '@deepseek-ai/dsh-util-text-search'
import type { Translate } from './presentation.ts'
import { PluginReference } from './PluginReference.tsx'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    plugin: { readonly packageName: string; readonly label: string }
  }
}

/** Fold canonical mentions in sent user text into plugin chips. */
export const pluginReferenceRule: UserTextRule<'plugin'> = {
  id: 'plugin',
  order: 20,
  match(text, from) {
    const match = nextPluginMention(text, from)
    if (match === undefined) return undefined
    return { id: 'plugin', start: match.start, end: match.end, data: { packageName: match.packageName, label: match.label } }
  },
}

/** Inventory and navigation capabilities the source consumes. */
export interface PluginReferenceDeps {
  readonly listBundles: () => Promise<readonly BundleInfo[]>
  readonly resolveText: (text: LocalizedText) => string
  readonly openBundle: (packageName: string) => boolean
  readonly t: Translate
}

/**
 * Build the `@` source that lists installed packages and inserts canonical mentions.
 * @param deps - inventory, locale, and navigation capabilities.
 * @returns the plugin reference source.
 */
export function createPluginReferenceSource(deps: PluginReferenceDeps): InputTriggerSource {
  return {
    trigger: '@',
    name: 'plugin',
    order: 1,
    showGroupTitle: false,
    async candidates(_session, { query, signal }) {
      const bundles = await deps.listBundles()
      if (signal.aborted) return []
      const needle = query.trim().toLowerCase()
      return bundles.filter(bundle => bundle.installed && isPluginPackageName(bundle.name)).map((bundle) => {
        const title = bundle.meta?.title === undefined ? bundle.name : deps.resolveText(bundle.meta.title) || bundle.name
        const description = bundle.meta?.description === undefined ? undefined : deps.resolveText(bundle.meta.description) || undefined
        return {
          packageName: bundle.name,
          title,
          description,
          search: [bundle.name, ...localizedValues(bundle.meta?.title), ...localizedValues(bundle.meta?.description)],
        }
      })
        .filter(row => needle === '' || row.search.some(value => value.toLowerCase().includes(needle)))
        .sort((left, right) =>
          Number(right.title.toLowerCase().startsWith(needle)) - Number(left.title.toLowerCase().startsWith(needle))
          || left.packageName.localeCompare(right.packageName))
        .map(row => ({
          name: row.packageName,
          label: row.title,
          ...(row.description === undefined ? {} : { description: row.description }),
          icon: PluginArtworkDefault,
          section: deps.t('pluginReferenceSection'),
          value: formatPluginMention({ packageName: row.packageName, label: row.title }),
        }))
    },
    onPick({ candidate }) {
      if (candidate.value === undefined) return undefined
      return {
        insert: {
          source: 'plugin',
          ref: candidate.value,
          label: candidate.label ?? candidate.name,
          clipboardText: candidate.value,
        },
      }
    },
    openReference(_session, { ref }) {
      const packageName = packageNameOfPluginMention(ref)
      return packageName === undefined ? false : deps.openBundle(packageName)
    },
    codec: {
      clipboardText: ref => ref,
      serialize: ref => Promise.resolve(ref),
    },
  }
}

/**
 * Register the `@` source, transcript rule, and plugin chip.
 * @param ctx - client root context.
 * @param t - the plugin manager dictionary.
 */
export function installPluginReference(ctx: ClientContext, t: Translate): void {
  let pending: Promise<readonly BundleInfo[]> | undefined
  const load = (): Promise<readonly BundleInfo[]> => {
    if (pending === undefined) {
      pending = (async () => {
        const result = await ctx.remote.pluginManager.listBundles()
        if (!result.ok) throw new Error(`pluginManager.listBundles failed: ${result.error.code}: ${result.error.message}`)
        return result.value
      })()
      pending.catch(() => { pending = undefined })
    }
    return pending
  }
  const clear = (): void => { pending = undefined }
  ctx.effect(() => {
    const disposers = [
      ctx.remote.$on('plugin-manager/changed', clear),
      ctx.on('connection/reset', clear),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-plugin-manager: plugin reference invalidation')
  ctx.inject(['inputTriggers', 'uiConversation', 'slots'], (scope) => {
    const source = createPluginReferenceSource({
      listBundles: load,
      resolveText: text => ctx.locale.resolveText(text),
      openBundle: (packageName) => {
        const navigation = ctx.get('pluginNavigation')
        if (navigation === undefined) return false
        navigation.openBundle(packageName)
        return true
      },
      t,
    })
    scope.effect(() => scope.inputTriggers.registerSource(source), 'ui-plugin-manager: @ plugin source')
    scope.effect(() => scope.uiConversation.userText.register(pluginReferenceRule), 'ui-plugin-manager: plugin reference rule')
    scope.slots.inject('conversation.user.text.node', () => scope.slots.register({
      name: 'conversation.user.text.node', key: 'plugin', priority: 100,
    }, PluginReference))
  })
}
