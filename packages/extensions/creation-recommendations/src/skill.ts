/** On-demand page planning with an English plugin catalog for duplicate checks. */
import { readFile } from 'node:fs/promises'
import { bundleCatalogEntry } from '@deepseek-ai/dsh-plugin-manager/catalog'
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK, type SkillCandidate } from '@deepseek-ai/dsh-skill'

/** Register the page planning skill behind the card switch, without a system-prompt section.
 * @param ctx - Owning plugin context with skill, plugin and card registries.
 */
export function registerCreationSkill(ctx: Context): void {
  const candidate: SkillCandidate = {
    name: 'personalized-pages',
    description: 'Plan an optional page or small tool when the user asks for a page, tab, panel, tool or interface in this app (even for one-off use), wants something to keep, revisit or update later, will keep changing data in your answer, or wants a live view of this app’s own data (Sessions, tasks, logs, workspace). Load this before reading any files or source; it says how to submit the proposal. Not for requested files or code, ordinary answers, existing-feature questions, quoted wishes or declined offers.',
    provider: 'dsh-personalized-pages', source: 'bundled', rank: BUNDLED_SKILL_RANK, locator: null,
    invocation: { modelInvocable: true, userInvocable: false },
  }
  ctx.skills.registerProvider(ctx.actionCards.skillProvider(candidate, async (_candidate, options) => {
    const instructions = await readFile(new URL('../skills/personalized-pages.md', import.meta.url), {
      encoding: 'utf8', signal: options.signal,
    })
    const bundles = await ctx.pluginManager.listBundles()
    options.signal?.throwIfAborted()
    const { rank: _rank, locator: _locator, ...summary } = candidate
    return {
      ...summary,
      content: instructions + '\n## Existing capabilities to check against this page plan\n\n'
        + JSON.stringify(bundles.filter(bundle => bundle.official).map(bundleCatalogEntry)),
    }
  }))
}
