/** On-demand catalog of the shipped optional plugins and the official connectors, for explicit product-use needs. */
import { readFile } from 'node:fs/promises'
import { bundleCatalogEntry } from '@deepseek-ai/dsh-plugin-manager/catalog'
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK, type SkillCandidate } from '@deepseek-ai/dsh-skill'
import type { BundleInfo } from '@deepseek-ai/dsh-plugin-manager/types'
import { OFFICIAL_CONNECTOR_CATALOG, type OfficialBundleCatalogEntry } from '@deepseek-ai/dsh-official-bundles'

/** Fixed opening of the skill's catalog entry: the product questions the shipped optional plugins answer. */
const DESCRIPTION_OPENING = 'Check DSH’s plugins when the user asks how to do something in this app, whether it can, or says a capability is missing or should change: input, thinking or title display, session search, terminals, worktrees, desktop control, automation, access, approvals, badges or signatures, plugin sources'
/**
 * Fixed closing of the skill's catalog entry. Naming all seven apps makes the entry 498 characters, within tool-skill's
 * default `catalogDescriptionMaxLength` of 500, beyond which the catalog would cut these exclusions.
 */
const DESCRIPTION_CLOSING = '. Not a request to develop DSH, even in its repo: load before reading files. Not for other tasks or quoted wishes.'

/** Whether a card may change a listed bundle: its files are readable, its selection is writable, and it reports no error. */
function usable(bundle: BundleInfo): boolean {
  return bundle.availability !== 'missing' && bundle.readOnlyReason === undefined && bundle.error === undefined
}

/** Shipped optional plugins only; no arbitrary install target is accepted.
 * @param bundle - a profile bundle as the plugin manager reports it.
 * @returns whether a card may offer and enable it.
 */
export function eligible(bundle: BundleInfo): boolean {
  return bundle.official && bundle.optional && usable(bundle)
}

/**
 * What a card's plugin is in the profile now: a bundle the card can enable, which an installed official connector also
 * is, or an official connector to install. `connector`, the connector's catalog entry, is present exactly for an
 * official connector.
 */
type Target =
  | { readonly kind: 'enable'; readonly bundle: BundleInfo; readonly connector?: OfficialBundleCatalogEntry }
  | { readonly kind: 'install'; readonly connector: OfficialBundleCatalogEntry }

/**
 * Classify a card's plugin against one plugin manager listing; the catalog and the card share this classification.
 * @param bundles - one listing from the plugin manager.
 * @param name - the plugin's package name.
 * @returns `enable` for an eligible plugin or an installed, usable official connector, `install` for an official
 * connector the profile does not hold, or undefined for anything else, which neither the catalog nor a card offers.
 */
export function targetOf(bundles: readonly BundleInfo[], name: string): Target | undefined {
  const bundle = bundles.find(item => item.name === name)
  const connector = OFFICIAL_CONNECTOR_CATALOG.find(item => item.packageName === name)
  if (connector === undefined) return bundle !== undefined && eligible(bundle) ? { kind: 'enable', bundle } : undefined
  if (bundle?.installed !== true) return { kind: 'install', connector }
  return usable(bundle) ? { kind: 'enable', bundle, connector } : undefined
}

/** Whether a card could offer a connector now: the profile does not hold it, or holds it usable and switched off. */
function offerable(target: Target | undefined): boolean {
  return target?.kind === 'install' || (target?.kind === 'enable' && !target.bundle.enabled)
}

/**
 * The skill's catalog entry for one plugin manager listing. It names, by English title in the connector catalog's
 * order, only the apps whose connector a card could offer now, so a task that needs the app of an enabled or unusable
 * connector does not load the skill; without such a connector the entry names no app.
 */
function skillDescription(bundles: readonly BundleInfo[]): string {
  const apps = OFFICIAL_CONNECTOR_CATALOG.filter(({ packageName }) => offerable(targetOf(bundles, packageName)))
    .map(connector => connector.meta.title.en)
  const last = apps.pop()
  const needs = last === undefined ? '' : `; or a task needs ${apps.length === 0 ? last : `${apps.join(', ')} or ${last}`}`
  return `${DESCRIPTION_OPENING}${needs}${DESCRIPTION_CLOSING}`
}

/**
 * Register the official-plugins skill behind the card switch, without adding a model tool or a system-prompt section.
 * The first catalog lookup composes the skill's entry from the plugin manager's listing, and every later lookup, from
 * any working directory or scope, reuses it until a Plugin Manager change; a listing that fails leaves the skill out of
 * that lookup's catalog, and the next lookup reads it again.
 * @param ctx - Owning plugin context with skill, plugin and card registries.
 */
export function registerOfficialPluginsSkill(ctx: Context): void {
  const candidate: SkillCandidate = {
    name: 'official-plugins',
    // Every lookup lists the entry its own listing composes; this one is that of a profile without any connector.
    description: skillDescription([]),
    invocation: { modelInvocable: true, userInvocable: false },
    provider: 'dsh-official-plugins', source: 'bundled', rank: BUNDLED_SKILL_RANK, locator: null,
  }
  const cards = ctx.actionCards.skillProvider(candidate, async (listed, { signal }) => {
    const policy = await readFile(new URL('../skills/official-plugins.md', import.meta.url), { encoding: 'utf8', signal })
    const bundles = await ctx.pluginManager.listBundles()
    // The connectors follow the eligible plugins in English; one a card cannot enable is left out, as an ineligible plugin is.
    const connectors = OFFICIAL_CONNECTOR_CATALOG.flatMap(({ packageName: name, meta: { title, description } }) => {
      const target = targetOf(bundles, name)
      if (target === undefined) return []
      const installed = target.kind === 'enable'
      return [{ name, title: title.en, description: description.en, enabled: installed && target.bundle.enabled, installed }]
    })
    const catalog = JSON.stringify([...bundles.filter(eligible).map(bundleCatalogEntry), ...connectors])
    signal?.throwIfAborted()
    // The definition carries the entry the catalog listed for this lookup.
    const { rank: _rank, locator: _locator, ...entry } = listed
    return { ...entry, content: `${policy}\n## Official plugins\n\n${catalog}` }
  })
  ctx.skills.registerProvider((control) => {
    const provider = cards(control)
    // One composed entry serves every lookup until a Plugin Manager change, since it does not depend on the cwd or scope.
    let composed: Promise<string> | undefined
    const compose = (): Promise<string> => {
      const read = ctx.pluginManager.listBundles().then(skillDescription)
      // A rejected listing is not kept, so the next lookup reads again; a newer entry a change started stays.
      void read.catch(() => { if (composed === read) composed = undefined })
      return read
    }
    // The manager announces every operation that can change which connectors a card could offer. It emits without a
    // scope receiver, so this plugin's listener receives it wherever the plugin is mounted, and leaves with the plugin.
    ctx.on('plugin-manager/changed', () => {
      composed = undefined
      control.invalidate()
    })
    return {
      ...provider,
      // A rejected listing propagates: the registry leaves this skill out of an incomplete catalog and retries next lookup.
      list: async (options) => {
        const listed = await provider.list(options)
        // The card service lists the skill only while recommendations are switched on.
        if (!Array.isArray(listed) || listed.length === 0) return listed
        options.signal?.throwIfAborted()
        composed ??= compose()
        // The registry stops waiting for a cancelled lookup itself; the shared read goes on for the other lookups.
        const description = await composed
        options.signal?.throwIfAborted()
        return [{ ...candidate, description }]
      },
    }
  })
}
