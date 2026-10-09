/** Optional Remote contribution and reasoning-slot registration lifecycle. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-experimental-client-ui-cot-translation/remote'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CotTranslationPreferences, CotTranslationSnapshot } from '../preferences.ts'
import { TranslationBody, type TranslationBodyInjected } from './TranslationBody.tsx'
import { TranslationSettings } from './TranslationSettings.tsx'
import { TranslationPreferencesForm } from './preferences-form.ts'
import { en, NS, zh } from './locales.ts'

/** Services required to mount the optional Remote and UI contributions. */
export const inject = ['remote', 'slots', 'locale', 'configForms']

async function registerUi(ctx: Context, lifetime: AbortController): Promise<void> {
  let readTask: Promise<RemoteResult<CotTranslationSnapshot>> | undefined
  let updating: Promise<void> | undefined
  let revision = 0, lastReadRevision = -1, acceptedRevision = -1
  const isDisposed = (): boolean => lifetime.signal.aborted || ctx.fiber.uid === null
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled([readTask, updating])
  }, 'cot-translation: metadata queries')
  const invalidate = (): void => { revision += 1; refresh() }
  ctx.effect(() => [
    ctx.remote.$on('settings/document-updated', invalidate),
    ctx.remote.$on('llm/adapters-updated', invalidate),
    ctx.remote.$on('deepseek-account/session-expired', invalidate),
    ctx.remote.$on('deepseek-account/model-sign-in-required', invalidate),
    ctx.remote.$on('credentials/record-updated', invalidate),
    ctx.remote.$on('credentials/reference-updated', invalidate),
  ])
  ctx.on('connection/reset', invalidate)
  const read = async (): Promise<RemoteResult<CotTranslationSnapshot> | undefined> => {
    while (true) {
      const observed = revision
      lastReadRevision = observed
      readTask = ctx.remote.cotTranslation.limits(lifetime.signal)
      const result = await readTask
      if (isDisposed()) return undefined
      if (observed === revision) return result
    }
  }
  let initial: RemoteResult<CotTranslationSnapshot> | undefined
  try { initial = await read() } catch (error) {
    if (isDisposed()) return
    throw error
  }
  if (initial === undefined) return
  if (!initial.ok) throw initial.error
  const preferences = createSnapshotStore(initial.value.preferences)
  const translationLimit = createSnapshotStore(initial.value.maxTextChars)
  const availableProviders = createSnapshotStore(initial.value.availableProviders)
  acceptedRevision = lastReadRevision
  function refresh(): void {
    if (updating !== undefined || acceptedRevision < 0 || isDisposed()) return
    updating = (async () => {
      try {
        const result = await read()
        if (result?.ok) {
          preferences.set(result.value.preferences)
          translationLimit.set(result.value.maxTextChars)
          availableProviders.set(result.value.availableProviders)
          acceptedRevision = lastReadRevision
        }
      } catch (_error) {
        if (!isDisposed()) ctx.logger.warn('cot-translation: could not refresh Host preferences and request limits')
      }
    })().finally(() => {
      updating = undefined
      if (revision !== lastReadRevision && !isDisposed()) refresh()
    })
  }
  const scope = ctx.configForms.get<CotTranslationPreferences>('cot-translation')
  ctx.effect(() => scope.subscribe(invalidate))
  ctx.effect(() => ctx.locale.register(NS, { en, zh }))
  const form = new TranslationPreferencesForm(scope)
  ctx.effect(() => () => { form.dispose() })
  const injected = (sessionId: SessionId): TranslationBodyInjected => ({
    hooks: { preferences, translationLocale: ctx.locale, translationLimit },
    translate: async (request, signal) => {
      if (acceptedRevision !== revision) refresh()
      while (updating !== undefined) await updating
      signal.throwIfAborted()
      const accepted = preferences.getSnapshot()
      if (isDisposed() || acceptedRevision !== revision || request.provider !== accepted.provider
        || (accepted.targetLanguage !== 'auto' && request.targetLanguage !== accepted.targetLanguage)
        || request.text.length > translationLimit.getSnapshot()) throw new Error('Translation preferences or limits changed')
      const result = await ctx.remote.cotTranslation.translate({ ...request, sessionId }, signal)
      if (!result.ok) throw result.error
      return result.value
    },
  })
  ctx.slots.inject('conversation.chat.reasoning.body', () => ctx.slots.register({
    name: 'conversation.chat.reasoning.body', locale: NS,
    inject: injected,
  }, TranslationBody))
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: '@deepseek-ai/dsh-experimental-cot-translation-bundle', locale: NS,
    inject: () => {
      const face = form.inject()
      return { ...face, hooks: { ...face.hooks, availableProviders }, refreshProviders: invalidate }
    },
  }, TranslationSettings))
}

/**
 * Mount Session-bound translation and withdraw UI before its generated Remote.
 * @param ctx - Client plugin lifetime.
 * @param contribution - generated controller Remote definitions.
 * @returns disposer that removes both contributions.
 */
export async function mountTranslation(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const lifetime = new AbortController()
  // Effect cleanup waits for pending setup; uid clearance cancels its query first.
  ctx.on('internal/plugin', (fiber) => { if (fiber === ctx.fiber && fiber.uid === null) lifetime.abort() })
  ctx.effect(() => () => { lifetime.abort() }, 'cot-translation: query cancellation')
  const unmountRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.cotTranslation', ...inject.slice(1)], child => registerUi(child, lifetime))
  try { await ui } catch (error) { await ui.dispose(); await unmountRemote(); throw error }
  return async () => { await ui.dispose(); await unmountRemote() }
}
