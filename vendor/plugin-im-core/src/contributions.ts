/**
 * Element handlers contributed by plugins: one tag, one handler, shared by every mode of every bot.
 *
 * A mode renders what its own registry holds; contributed handlers are the second source, so a plugin can teach every
 * adapter a tag it knows without any adapter naming it. A mode that registers the tag itself keeps its own handler —
 * a contribution only fills what no registry declares. `@deepseek-ai/cordis-plugin-im-markdown` contributes
 * `<markdown>` this way.
 *
 * @module @deepseek-ai/cordis-plugin-im-core/contributions
 */

import type { Element, Tag } from '@deepseek-ai/satori-element'
import type { ModeTypes } from './mode.ts'
import type { RegistryEntry, RenderContext } from './registry.ts'

/**
 * A handler valid in every mode: it renders with the platform node type of the mode publishing the message, which is
 * why it takes its result from `RenderContext.transform` instead of building adapter nodes itself.
 */
export type ContributedHandler<K extends Tag = Tag> =
  <T extends ModeTypes>(el: Element<K>, ctx: RenderContext<T>) => T['node'] | readonly T['node'][]

/**
 * The contributed handlers of one `satori` service.
 *
 * `register` returns its own disposer: a plugin installs it inside `ctx.effect()`, so unloading the plugin withdraws
 * the handler again.
 */
export class ElementContributions {
  private readonly entries = new Map<Tag, ContributedHandler>()

  /**
   * Contribute a handler for `tag`.
   *
   * @param tag - the element tag this handler renders.
   * @param handler - renders the element in every mode.
   * @returns the disposer that withdraws the handler.
   */
  register<K extends Tag>(tag: K, handler: ContributedHandler<K>): () => void {
    this.entries.set(tag, handler as ContributedHandler)
    return () => {
      if (this.entries.get(tag) === handler) this.entries.delete(tag)
    }
  }

  /**
   * The contributed handler of a tag, in the shape a mode registry returns.
   *
   * @param tag - the element tag.
   * @returns the handler as an entry without variants, or `undefined` when nothing contributes `tag`.
   */
  entry(tag: Tag): RegistryEntry<any, any> | undefined {
    const handler = this.entries.get(tag)
    if (!handler) return undefined
    return { tag, handler: handler as never, options: {} }
  }

  /** Tags a plugin contributes. */
  tags(): Tag[] {
    return [...this.entries.keys()]
  }
}
