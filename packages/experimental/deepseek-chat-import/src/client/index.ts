/** Browser half: the import action after New session and its Remote calls. */
import type { Context } from '@deepseek-ai/cordis'
import remote from '@deepseek-ai/dsh-deepseek-chat-import/remote'
import { mountImport } from './mount.ts'
import type { DeepseekChatImportKey } from './locales.ts'

export { inject } from './mount.ts'
export type { DeepseekChatImportInjected, DeepseekChatImportOutcome, ImportSessionsActionProps } from './ImportSessions.tsx'
export type { DeepseekChatImportKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** DeepSeek chat export import action and dialog copy. */
    deepseekChatImport: DeepseekChatImportKey
  }
}

/**
 * Mount the import action and its Remote methods.
 * @param ctx - browser plugin context.
 * @returns disposer joining UI and Remote withdrawal.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountImport(ctx, remote)
}
