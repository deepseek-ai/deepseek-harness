/**
 * Core `transform()`: root `<fallback>` resolution → envelope extraction (`<quote>`, `<title>`) → registry walk with
 * lazy fallback → `mode.assemble` → `onClick` action collection. Pure and synchronous: no I/O, no awaits; a handler
 * returning a promise is an error.
 *
 * Envelope rules:
 * - A root `<fallback>` is resolved first (see `registry.ts`, rule 5), so its chosen candidate can carry envelope tags.
 * - `<quote id>` is hoisted to `TransformResult.quote` and never rendered.
 * - The first root `<title>` goes to `Envelope.title` (the mode's `assemble` renders it, e.g. Lark post `title`, card
 *   header) when the mode's registry declares `title` as an envelope tag (`ElementRegistry.envelope('title')`);
 *   otherwise it stays in the content and takes the core fallback `<p><b>…</b></p>` + `<small>` subtitle.
 * - `actions` are the `onClick` callbacks of `button[type=action]` elements whose handler ran (a button lowered to
 *   text has no callback to register; the core fallback reports it as `dropped`).
 */

import type { Element } from '@deepseek-ai/satori-element'
import type { Bot } from './bot.ts'
import { createRenderReport } from './fallback.ts'
import type { Envelope, Mode, ModeTypes, TransformResult } from './mode.ts'
import type { Target } from './protocol.ts'
import { RenderEngine } from './registry.ts'
import type { StreamPhase } from './stream.ts'

export interface TransformOptions<T extends ModeTypes> {
  bot: Bot
  target: Target
  mode: Mode<T>
  /** The stream state being rendered (`RenderContext.stream`); omitted outside a stream. */
  stream?: StreamPhase | undefined
}

/** Transform a normalized `<message>` into the mode's drafts. */
export function transform<T extends ModeTypes>(content: Element<'message'>, options: TransformOptions<T>): TransformResult<T['draft']> {
  if (content?.type !== 'message') throw new TypeError('transform() expects a normalized <message> root (use normalize())')
  const { bot, target, mode, stream } = options
  const report = createRenderReport()
  const engine = new RenderEngine<T>(mode.elements, {
    bot,
    target,
    mode: mode.id,
    limits: mode.limits,
    report,
    stream,
    contributions: bot.ctx?.get('satori')?.elements,
  })
  engine.register(content, undefined, 'message', 0)

  const roots: Element[] = []
  const expand = (nodes: readonly Element[]) => {
    for (const node of nodes) {
      if (node.type === 'fallback') expand(engine.choose(node)?.children ?? [])
      else roots.push(node)
    }
  }
  expand(content.children)

  const envelope: Envelope = {}
  const body: Element[] = []
  for (const child of roots) {
    if (child.type === 'quote') {
      envelope.quote ??= child.attrs.id
    } else if (child.type === 'title' && envelope.title === undefined && mode.elements.inEnvelope('title')) {
      envelope.title = child
    } else {
      body.push(child)
    }
  }

  const nodes = engine.renderChildren(body, content)
  // An intermediate stream state whose body renders nothing yet (markdown still writing its first block) has nothing
  // to publish; the pipeline skips it instead of opening the stream with an empty message.
  if (!nodes.length && stream?.final === false) return { msgs: [], actions: [], report }
  const msgs = mode.assemble(nodes, envelope, engine.context(content))
  if (msgs && typeof (msgs as unknown as { then?: unknown }).then === 'function') {
    throw new TypeError(`assemble of mode "${mode.id}" returned a promise; transform is synchronous`)
  }
  return {
    msgs: [...msgs],
    ...envelope.quote !== undefined && { quote: envelope.quote },
    actions: engine.actions(),
    report,
  }
}
