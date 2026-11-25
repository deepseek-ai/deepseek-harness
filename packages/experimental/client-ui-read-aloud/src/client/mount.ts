/** Source-safe lifecycle for the optional read-aloud Remote and browser UI. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-account/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-read-aloud/remote'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { ReadAloudAction, type ReadAloudActionInjected } from './ReadAloudAction.tsx'
import { ReadAloudNotice, type ReadAloudNoticeInjected } from './ReadAloudNotice.tsx'
import { ReadAloudSettings, type ReadAloudSettingsInjected } from './ReadAloudSettings.tsx'
import { en, ja, es, fr, de, ru, pt, NS, zh } from './locales.ts'
import { createPcmPlayer } from './player.ts'
import { Reader } from './reader.ts'
import { observeStatus } from './status.ts'

export const inject = ['remote', 'slots', 'locale']

/** Package whose bundle details carry the read-aloud section. */
const BUNDLE = '@deepseek-ai/dsh-read-aloud-bundle'

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }))
  const status = observeStatus(ctx)
  ctx.effect(() => status.dispose)
  const reader = new Reader({
    plan: async (target, signal) => {
      const result = await ctx.remote.readAloud.plan(target, signal)
      if (!result.ok) throw result.error
      return result.value
    },
    synthesize: (request, signal) => ctx.remote.readAloud.synthesize(request, signal),
    sample: (request, signal) => ctx.remote.readAloud.sample(request, signal),
    createPlayer: () => createPcmPlayer(),
  })
  ctx.effect(() => () => { reader.dispose() })
  // The account UI provides sign-in only while the current Peer may watch the account.
  const accountSignIn = createSnapshotStore(false)
  ctx.inject(['accountSignIn'], (scope: Context) => {
    scope.effect(() => {
      accountSignIn.set(true)
      return () => { accountSignIn.set(false) }
    }, 'read-aloud: account sign-in presence')
  })
  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions', id: 'read-aloud', order: 20, locale: NS,
    inject: (sessionId): ReadAloudActionInjected => ({
      hooks: { reader: reader.state, readAloudStatus: status.state },
      toggle: (messageId) => { reader.toggle({ sessionId, messageId }) },
    }),
  }, ReadAloudAction))
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay', id: 'read-aloud-notice', order: 3, locale: NS,
    inject: (sessionId): ReadAloudNoticeInjected => ({
      hooks: { reader: reader.state },
      leave: () => { reader.leave(sessionId) },
      dismissNotice: (seq) => { reader.dismissNotice(seq) },
    }),
  }, ReadAloudNotice))
  // One set of verbs for every rendering of the details, so the section's exit effect runs once per mount.
  const settings: ReadAloudSettingsInjected = {
    hooks: { readAloudStatus: status.state, reader: reader.state, accountSignIn },
    signIn: () => { ctx.get('accountSignIn')?.open() },
    configure: async (voice) => {
      const result = await ctx.remote.readAloud.configure({ voice })
      if (!result.ok) throw result.error
    },
    toggleSample: (sample) => { reader.toggleSample(sample) },
    stopSample: () => { reader.stopSample() },
    dismissSampleNotice: (seq) => { reader.dismissSampleNotice(seq) },
  }
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: BUNDLE, locale: NS, inject: () => settings,
  }, ReadAloudSettings))
}

/**
 * Mount this experimental namespace without adding it to stable API Remotes.
 * @param ctx - Client runtime owning the Remote, dictionaries and slots.
 * @param contribution - generated read-aloud Remote definitions.
 * @returns disposer joining UI and Remote withdrawal.
 */
export async function mountReadAloud(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.readAloud', 'slots', 'locale'], registerUi)
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
