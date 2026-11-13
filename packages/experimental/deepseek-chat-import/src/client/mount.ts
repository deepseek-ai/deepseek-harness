/** Remote contribution mounting and the `sidebar.session.action` layer. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-deepseek-chat-import/remote'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { ImportSessionsAction } from './ImportSessions.tsx'
import type { DeepseekChatImportInjected, DeepseekChatImportOutcome } from './ImportSessions.tsx'
import { de, en, es, fr, ja, NS, pt, ru, zh } from './locales.ts'
import { uploadArchive } from './upload.ts'

/** Services the browser half reads. */
export const inject = ['remote', 'slots', 'locale', 'sessions']

/**
 * Register the dictionaries and the `sidebar.session.action` layer.
 * @param ctx - Context injecting the mounted `deepseekChatImport` Remote namespace.
 */
function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'deepseek-chat-import: dictionaries')
  const injected: DeepseekChatImportInjected = {
    importArchive: async (file, workspaceId, onProgress, signal): Promise<DeepseekChatImportOutcome> => {
      try {
        const limits = await ctx.remote.deepseekChatImport.limits(signal)
        if (!limits.ok) return { ok: false, reason: 'unknown', message: limits.error.message }
        const limit = limits.value.maxUploadBytes
        if (file.size > limit) return { ok: false, reason: 'too-large', message: `the file exceeds ${limit} bytes`, limit }
        const answer = await uploadArchive(file, workspaceId, onProgress, signal)
        if ('transport' in answer) return { ok: false, reason: 'upload-failed', message: answer.transport }
        // The pre-check limit above is not the Host's entry limit, so only that
        // check contributes a byte limit; a Host failure carries its own message.
        if (!answer.ok) return { ok: false, reason: answer.error.reason, message: answer.error.message }
        return { ok: true, result: answer.value }
      } finally {
        // Imported Sessions are written without a live Agent, so the list learns of them only by reloading,
        // including Sessions written before a failure or cancellation. A failed reload leaves the outcome intact.
        await ctx.sessions.refresh().catch((error: unknown) => { ctx.logger.warn('deepseek-chat-import: session list refresh failed', error) })
      }
    },
  }
  ctx.slots.inject('sidebar.session.action', () => ctx.slots.register({
    name: 'sidebar.session.action',
    id: 'deepseek-chat-import',
    locale: NS,
    inject: () => injected,
  }, ImportSessionsAction))
}

/**
 * Mount the generated Remote contribution, then the UI that calls it.
 * @param ctx - browser plugin context.
 * @param contribution - generated `deepseekChatImport` Remote definitions.
 * @returns disposer withdrawing the UI before the Remote namespace.
 */
export async function mountImport(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.deepseekChatImport', ...inject.slice(1)], registerUi)
  return async () => {
    await ui.dispose()
    await unmountRemote()
  }
}

