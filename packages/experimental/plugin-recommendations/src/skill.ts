/** On-demand official-plugin catalog for explicit product-use needs. */
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK, type SkillCandidate } from '@deepseek-ai/dsh-skill'
import type { BundleInfo } from '@deepseek-ai/dsh-plugin-manager/types'

/** Shipped optional plugins only; no arbitrary install target is accepted.
 * @param bundle - a profile bundle as the plugin manager reports it.
 * @returns whether a card may offer and enable it.
 */
export function eligible(bundle: BundleInfo): boolean {
  return bundle.official && bundle.optional && bundle.availability !== 'missing'
    && bundle.readOnlyReason === undefined && bundle.error === undefined
}

/** The eligible plugins as the skill lists them: name, title, description and selection. */
function catalogOf(bundles: readonly BundleInfo[]): string {
  return JSON.stringify(bundles.filter(eligible).map(bundle => ({
    name: bundle.name, title: bundle.meta?.title ?? bundle.name,
    description: bundle.meta?.description ?? bundle.description ?? '', enabled: bundle.enabled,
  })))
}

/** Register the experiment's skill without adding a model tool or a system-prompt section.
 * @param ctx - Owning plugin context with skill and plugin registries.
 */
export function registerOfficialPluginsSkill(ctx: Context): void {
  const candidate: SkillCandidate = {
    name: 'official-plugins',
    description: 'Check DSH’s optional plugins when the user asks how to do or use something in this app, whether it can, or says a capability is missing or should change: tools, input, thinking or title display, session search, terminals, worktrees, agent teams, desktop control, automation, access, approvals, badges or signatures, plugins or plugin sources. Not a request to develop DSH, even in its own repository: load before reading files or source. Not for ordinary tasks, quoted wishes or declined offers.',
    invocation: { modelInvocable: true, userInvocable: false },
    provider: 'dsh-official-plugins', source: 'bundled', rank: BUNDLED_SKILL_RANK, locator: null,
  }
  ctx.skills.registerProvider(() => ({
    name: candidate.provider,
    list: () => Promise.resolve([candidate]),
    async get(_candidate, { signal }) {
      const policy = await readFile(new URL('../skills/official-plugins.md', import.meta.url), { encoding: 'utf8', signal })
      const catalog = catalogOf(await ctx.pluginManager.listBundles())
      signal?.throwIfAborted()
      const { rank: _rank, locator: _locator, ...entry } = candidate
      return { ...entry, content: `${policy}\n## Official plugins\n\n${catalog}` }
    },
  }))
}
