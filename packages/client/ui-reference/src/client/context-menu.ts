/** File references contributed to the shared file menu. */
import type { Context } from '@deepseek-ai/cordis'
import type { ContextMenuTargetMap } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'
import { resolveWorkspacePath, workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { ReferenceKey } from './locales.ts'

/**
 * Add the captured file to its Session draft without submitting or replacing selected text.
 * @param ctx - reference plugin's menu and conversation dependencies.
 * @param t - localized labels and failure feedback.
 */
export function registerReferenceMenu(ctx: Context, t: (key: ReferenceKey) => string): void {
  ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
    name: 'contextMenu.icon', key: 'reference.addToChat',
  }, IconPlusOutlineRegular))
  const targetInput = ({ sessionId }: ContextMenuTargetMap['file']) => {
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) return undefined
    const input = ctx.conversation.input.for(binding.ctx)
    const blocks = ctx.conversation.blocks.storeFor(sessionId)
    const editable = (): boolean => {
      if (ctx.sessions.binding(sessionId) !== binding) return false
      const state = binding.session.getSnapshot()
      const phase = input.state.getSnapshot().phase
      return !state.removed && (state.subagent === null || state.subagent.address.mode === 'continuable')
        && blocks.getSnapshot() === undefined && (phase === 'plain' || phase === 'claimed')
    }
    return { binding, input, blocks, editable }
  }
  ctx.effect(() => ctx.contextMenus.register({
    id: 'reference.file', target: 'file', order: 300,
    observe: (target) => {
      const current = targetInput(target)
      return current === undefined ? [ctx.locale] : [ctx.locale, current.binding.session, current.input.state, current.blocks]
    },
    resolve: (target) => {
      const current = targetInput(target)
      const path = resolveWorkspacePath(ctx.sessions.list.getSnapshot().byId[target.sessionId]?.cwd, target.path)
      const mention = formatFileMention({ path, kind: 'file' }, false)
      return [{
        id: 'addToChat', label: t('menu.addToChat'), icon: { key: 'reference.addToChat' }, separatorBefore: true,
        disabled: mention === undefined || current === undefined || !current.editable(),
        failureLabel: t('menu.addToChatFailed'),
        run: () => {
          if (mention === undefined || current === undefined || !current.editable()
            || !current.input.addFiles([{
              source: 'reference', ref: mention, label: workspaceTitleOf(path),
              appearance: 'file', clipboardText: mention,
            }], [])) throw new Error('File reference insertion unavailable')
          current.input.focus()
        },
      }]
    },
  }), 'ui-reference: file context menu')
}
