// read_image toolview registrant: the keyed toolview hole for the read_image
// tool. The row composes the shared read-family assembly and feeds it the durable
// image reference as ToolRow's `image` card material, so the image renders through
// the Tool-owned `tool.call.images` slot inside the collapsed-by-default expanded
// body — the same unified interaction every other card row has. The attachment
// presentation plugin fills that slot; the tool layer only ever supplies the
// references and the session-authorized loader it received from the chat node.
//
// Claiming the `read_image` key suppresses the generic fallback for EVERY
// read_image result, so this component must cover all of the tool's shapes, not
// only the happy one: a running call (no result yet), a settled image, a refusal
// (a text-only route, a missing attachment service, an unreadable file), and a
// cancelled call. Each of those settles without an `image` card, and the row falls
// back to its text body for them.
//
// Like the read card, the image card is result-side only: a call carries no
// content until `execute` returns, so a running read_image shows the summary row
// alone.

import type { Context } from '@deepseek-ai/cordis'
import { imageCardModel } from '../models/image-card-model.ts'
import { readFamilyRow, type ReadImageRowProps } from './read-family-row.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'

/**
 * read_image row: the read-family chrome with the durably committed image as the
 * row's collapsed-by-default card body, rendered through the `tool.call.images`
 * slot this entry declares.
 */
export function ReadImageRow(props: ReadImageRowProps) {
  const { block, cwd, home, renderSlot, loadImage } = props
  return readFamilyRow(props, {
    image: imageCardModel(block, cwd, home),
    renderSlot,
    loadImage,
  })
}

/**
 * The read_image row as a plain registrant plugin following the atomic Tool-view
 * declaration across independent activation and reload lifetimes. Declaring
 * `tool.call.images` as a child slot authorizes this entry's `renderSlot` to
 * dispatch the gallery.
 */
export const readImageToolview = {
  name: 'read-image-toolview',
  inject: ['slots'],
  /**
   * Register the read_image row into the Tool-owned keyed view slot.
   * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
   */
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', () =>
      ctx.slots.register({
        name: 'tool.call.toolview',
        key: 'read_image',
        locale: NS,
        children: { 'tool.call.images': { kind: 'single', scope: 'session' } },
      }, ReadImageRow))
  },
}
