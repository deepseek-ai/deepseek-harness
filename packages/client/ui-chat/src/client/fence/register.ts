/** Registration of Chat's Markdown fence layers. */
import type { Context } from '@deepseek-ai/cordis'
import { NS } from '../locale.ts'
import { DiffFenceLayer, MathFenceLayer } from './FenceLayers.tsx'

/**
 * Register Chat's fence layers into the flow's language-keyed fence Slot;
 * they follow its declaration and the plugin's lifetime. Ids stay literal so
 * the Client slot catalog can name each occupied layer.
 * @param ctx - the Chat plugin context.
 */
export function registerFenceLayers(ctx: Context): void {
  ctx.slots.inject('conversation.chat.markdown.fence', () => ctx.slots.register({
    name: 'conversation.chat.markdown.fence', key: 'math', id: '@deepseek-ai/dsh-client-ui-chat/fence/math',
  }, MathFenceLayer))
  ctx.slots.inject('conversation.chat.markdown.fence', () => ctx.slots.register({
    name: 'conversation.chat.markdown.fence', key: 'diff', id: '@deepseek-ai/dsh-client-ui-chat/fence/diff', locale: NS,
  }, DiffFenceLayer))
  ctx.slots.inject('conversation.chat.markdown.fence', () => ctx.slots.register({
    name: 'conversation.chat.markdown.fence', key: 'patch', id: '@deepseek-ai/dsh-client-ui-chat/fence/diff', locale: NS,
  }, DiffFenceLayer))
}
