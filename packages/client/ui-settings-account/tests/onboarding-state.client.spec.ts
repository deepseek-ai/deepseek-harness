import type { TranscriptViewMode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { DeveloperToolsPreference } from '@deepseek-ai/dsh-client-ui-settings/src/client/developer-tools.ts'
import { SettingsSchemaService } from '@deepseek-ai/dsh-client-ui-settings/src/client/schema.ts'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { ConfigFormController } from '@deepseek-ai/dsh-client-ui-settings/src/client/config-form.ts'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { AccountSnapshot } from '../src/client/AccountSection.tsx'
import { DesktopOnboardingController } from '../src/client/onboarding-state.ts'
import { DESKTOP_ONBOARDING_NAMESPACE, OnboardingSettingsSchema, type OnboardingProgress, type OnboardingSettings } from '../src/onboarding-settings.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

function accountState(status?: 'credential-stored' | 'signed-out'): AccountSnapshot {
  return {
    view: status === undefined ? undefined : { status, attempt: null, links: { usageUrl: 'https://platform.example/usage', topUpUrl: 'https://platform.example/top_up' } },
    details: undefined, failed: false,
  }
}

async function harness(options: {
  status?: 'credential-stored' | 'signed-out'
  progress?: Partial<OnboardingProgress>
  keys?: () => Promise<boolean>
  omitNulls?: boolean
  writable?: boolean
  failRead?: () => boolean
  waitSettings?: Promise<void>
} = {}) {
  const data: Record<string, unknown> = {
    [DESKTOP_ONBOARDING_NAMESPACE]: OnboardingSettingsSchema({ purpose: null, process: null, completion: null, ...options.progress }),
    'ui-chat': { transcriptView: 'compact', performanceUsage: 'detailed' },
    'ui-settings': { enabled: false },
  }
  let revision = 0
  let refusal: string | undefined
  let waitWrite: Promise<void> | undefined
  let waitNamespace: string | undefined
  const namespace = (ns: string) => ({ ns, schema: {}, value: data[ns], applies: 'live' as const, secrets: [], revision })
  const mutate = vi.fn(async (ns: string, ops: SettingsPathOpView[]) => {
    if (waitNamespace === undefined || waitNamespace === ns) await waitWrite
    if (ns === refusal) return { ok: false, error: { code: 'settings/conflict', message: 'changed elsewhere' } }
    const next = { ...data[ns] as Record<string, unknown> }
    for (const op of ops) {
      if (op.op === 'set') next[op.path[0]!] = op.value
    }
    data[ns] = options.omitNulls ? Object.fromEntries(Object.entries(next).filter(([, value]) => value !== null)) : next
    revision++
    return { ok: true, value: namespace(ns) }
  })
  const ctx = { remote: { settings: {
    describe: async () => {
      await options.waitSettings
      if (options.failRead?.()) throw new Error('temporary describe failure')
      return { ok: true, value: { namespaces: Object.keys(data).map(namespace), writable: options.writable ?? true, hasDocument: true } }
    },
    mutate,
  } } } as never
  const schema = new SettingsSchemaService(new Context())
  const mirror = new SettingsDescribeMirror(ctx)
  const progress = new ConfigFormController(ctx, {
    namespace: DESKTOP_ONBOARDING_NAMESPACE,
    decode: value => OnboardingSettingsSchema(value as OnboardingSettings),
  }, mirror, 'host', schema)
  const chat = new ConfigFormController<{ transcriptView: TranscriptViewMode; performanceUsage: 'compact' | 'detailed' }>(ctx, {
    namespace: 'ui-chat', decode: value => value as { transcriptView: TranscriptViewMode; performanceUsage: 'compact' | 'detailed' },
  }, mirror, 'host', schema)
  const developerScope = new ConfigFormController<{ enabled: boolean }>(ctx, {
    namespace: 'ui-settings', decode: value => value as { enabled: boolean },
  }, mirror, 'host', schema)
  const developerTools = new DeveloperToolsPreference(developerScope)
  const setDeveloperTools = (enabled: boolean) => developerTools.setEnabled(enabled)
  cleanup.push(() => developerScope.dispose())
  const account = createSnapshotStore(accountState(options.status))
  const readKeys = vi.fn(options.keys ?? (async () => false))
  const controller = new DesktopOnboardingController(progress, chat, setDeveloperTools, account, readKeys, mirror)
  cleanup.push(() => progress.dispose(), () => chat.dispose(), () => { controller.dispose() })
  const loaded = mirror.load()
  if (options.waitSettings === undefined) await loaded
  return {
    controller, setDeveloperTools, account, readKeys, data, mutate, progress, chat, loaded, mirror,
    refuse(ns?: string) { refusal = ns },
    wait(promise?: Promise<void>, ns?: string) { waitWrite = promise; waitNamespace = ns },
  }
}

describe('desktop onboarding lifecycle', () => {
  it('counts bonus-only credit before entry', async () => {
    const h = await harness({ status: 'credential-stored' })
    h.account.set({ ...h.account.getSnapshot(), details: { balance: { status: 'ready', value: [{ currency: 'CNY', balance: '0' }], bonusWallets: [{ currency: 'CNY', balance: '1' }] } } })
    await h.controller.update({ step: 'credit' })
    expect(h.controller.state.getSnapshot().creditFunded).toBe(true)
  })

  it('keeps the published snapshot stable when account details do not change onboarding', async () => {
    const h = await harness({ status: 'credential-stored' })
    const before = h.controller.state.getSnapshot()
    h.account.set({ ...h.account.getSnapshot(), details: {} })
    expect(h.controller.state.getSnapshot()).toBe(before)
  })

  it('rejects an unchanged progress write when the Host refuses it', async () => {
    const h = await harness({ status: 'credential-stored', progress: { step: 'credit' } })
    h.refuse(DESKTOP_ONBOARDING_NAMESPACE)
    expect(await h.controller.update({ step: 'credit' })).toBe(false)
    expect(h.controller.state.getSnapshot().error).toBe('settings')
  })

  it('does not finish when matching Chat preferences were refused', async () => {
    const h = await harness({ status: 'credential-stored', progress: { step: 'process', purpose: 'development', process: 'compact' } })
    h.refuse('ui-chat')
    expect(await h.controller.complete('completed')).toBe(false)
    expect(h.controller.state.getSnapshot().progress.step).toBe('process')
  })

  it('keeps funded credit visible and freezes its actions without persisting the decision', async () => {
    const h = await harness({ status: 'credential-stored' })
    h.account.set({ ...h.account.getSnapshot(), details: { balance: { status: 'ready', bonusWallets: [], value: [{ currency: 'USD', balance: '0.01' }] } } })
    await h.controller.update({ step: 'credit' })
    expect(h.controller.state.getSnapshot()).toMatchObject({ progress: { step: 'credit' }, creditFunded: true })
    h.account.set({ ...h.account.getSnapshot(), details: { balance: { status: 'failed' } } })
    await h.controller.update({ step: 'purpose' })
    await h.controller.update({ step: 'credit' })
    expect(h.controller.state.getSnapshot()).toMatchObject({ progress: { step: 'credit' }, creditFunded: true })
    expect(h.data[DESKTOP_ONBOARDING_NAMESPACE]).not.toHaveProperty('creditFunded')
    h.controller.dispose()
    const reopened = new DesktopOnboardingController(h.progress, h.chat, h.setDeveloperTools, h.account, h.readKeys, h.mirror)
    cleanup.push(() => { reopened.dispose() })
    expect(reopened.state.getSnapshot()).toMatchObject({ progress: { step: 'credit' }, creditFunded: false })
  })

  it.each(['0', '-1'])('keeps unfunded actions for balance %s when a positive result arrives after entry', async (balance) => {
    const h = await harness({ status: 'credential-stored' })
    h.account.set({ ...h.account.getSnapshot(), details: { balance: { status: 'ready', bonusWallets: [], value: [{ currency: 'CNY', balance }] } } })
    await h.controller.update({ step: 'credit' })
    h.account.set({ ...h.account.getSnapshot(), details: { balance: { status: 'ready', bonusWallets: [], value: [{ currency: 'CNY', balance: '10' }] } } })
    expect(h.controller.state.getSnapshot()).toMatchObject({ progress: { step: 'credit' }, creditFunded: false })
    await h.controller.update({ step: 'purpose' })
    await h.controller.update({ step: 'credit' })
    expect(h.controller.state.getSnapshot().creditFunded).toBe(false)
  })

  it('uses a balance received before saved credit progress loads without rewriting progress', async () => {
    const settings = Promise.withResolvers<undefined>()
    const h = await harness({ status: 'credential-stored', progress: { step: 'credit' }, waitSettings: settings.promise })
    h.account.set({ ...h.account.getSnapshot(), details: { balance: { status: 'ready', bonusWallets: [], value: [{ currency: 'CNY', balance: '1' }] } } })
    settings.resolve(undefined)
    await h.loaded
    expect(h.controller.state.getSnapshot()).toMatchObject({ progress: { step: 'credit' }, creditFunded: true })
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('freezes credit actions at immediate entry while navigation persists', async () => {
    const h = await harness({ status: 'credential-stored' })
    const write = Promise.withResolvers<undefined>()
    h.wait(write.promise)
    const saved = h.controller.update({ step: 'credit' })
    h.account.set({ ...h.account.getSnapshot(), details: { balance: { status: 'ready', bonusWallets: [], value: [{ currency: 'CNY', balance: '1' }] } } })
    write.resolve(undefined)
    expect(await saved).toBe(true)
    expect(h.controller.state.getSnapshot()).toMatchObject({ progress: { step: 'credit' }, creditFunded: false })
  })

  it('does not change credit actions when the first balance result arrives after entry', async () => {
    const h = await harness({ status: 'credential-stored' })
    await h.controller.update({ step: 'credit' })
    h.account.set({ ...h.account.getSnapshot(), details: { balance: { status: 'ready', bonusWallets: [], value: [{ currency: 'CNY', balance: '1' }] } } })
    expect(h.controller.state.getSnapshot().creditFunded).toBe(false)
    h.account.set(accountState('signed-out'))
    h.account.set({ ...accountState('credential-stored'), details: { balance: { status: 'ready', bonusWallets: [], value: [{ currency: 'CNY', balance: '1' }] } } })
    expect(h.controller.state.getSnapshot().creditFunded).toBe(true)
  })

  it.each(['welcome', 'done'] as const)('covers the main page while saved %s progress loads for a signed-in account', async (step) => {
    const settings = Promise.withResolvers<undefined>()
    const h = await harness({ status: 'credential-stored', progress: { step }, waitSettings: settings.promise })
    expect(h.controller.state.getSnapshot()).toMatchObject({ status: 'loading', visible: true })
    settings.resolve(undefined)
    await h.loaded
    expect(h.controller.state.getSnapshot()).toMatchObject({ status: 'ready', visible: step !== 'done', progress: { step } })
  })

  it('waits for account resolution before deciding that existing credentials are API-key-only', async () => {
    const h = await harness({ keys: async () => true })
    expect(h.controller.state.getSnapshot()).toMatchObject({ status: 'loading', visible: false })
    expect(h.readKeys).not.toHaveBeenCalled()
    h.account.set(accountState('credential-stored'))
    expect(h.controller.state.getSnapshot()).toMatchObject({ visible: true, progress: { step: 'welcome' } })
    expect(h.readKeys).not.toHaveBeenCalled()
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('keeps an unauthenticated installation unfinished and never fabricates API-key completion', async () => {
    const h = await harness({ status: 'signed-out' })
    await vi.waitFor(() => { expect(h.readKeys).toHaveBeenCalledOnce() })
    expect(h.controller.state.getSnapshot()).toMatchObject({ visible: false, progress: { step: 'welcome', completion: null } })
    expect(await h.controller.update({ step: 'credit' })).toBe(false)
    expect(await h.controller.complete('skipped')).toBe(false)
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('applies API-key defaults once and does not rerun onboarding after a later account login', async () => {
    const h = await harness({ status: 'signed-out', keys: async () => true })
    await vi.waitFor(() => { expect(h.controller.state.getSnapshot().progress.step).toBe('done') })
    expect(h.data['ui-chat']).toEqual({ transcriptView: 'standard', performanceUsage: 'detailed' })
    expect(h.data['ui-settings']).toEqual({ enabled: true })
    expect(h.data[DESKTOP_ONBOARDING_NAMESPACE]).toMatchObject({ completion: 'api-key', process: 'standard', usage: 'detailed', developerTools: true })
    h.account.set(accountState('credential-stored'))
    h.controller.invalidateCredentials()
    expect(h.controller.state.getSnapshot().visible).toBe(false)
    expect(h.mutate).toHaveBeenCalledTimes(3)
  })

  it('leaves preferences changed after completion untouched on the next launch', async () => {
    const h = await harness({ status: 'credential-stored', progress: { step: 'done', completion: 'completed' } })
    expect(h.mutate).not.toHaveBeenCalled()
    expect(h.data['ui-chat']).toEqual({ transcriptView: 'compact', performanceUsage: 'detailed' })
    expect(h.data['ui-settings']).toEqual({ enabled: false })
  })

  it('does not finish a newly signed-in account from a stale key-presence response', async () => {
    const deferred = Promise.withResolvers<boolean>()
    const h = await harness({ status: 'signed-out', keys: () => deferred.promise })
    h.account.set(accountState('credential-stored'))
    deferred.resolve(true)
    await deferred.promise
    expect(h.controller.state.getSnapshot()).toMatchObject({ visible: true, progress: { step: 'welcome' } })
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it.each(['ui-chat', 'ui-settings', DESKTOP_ONBOARDING_NAMESPACE])('discards failed API-key completion after %s refuses a write and the user signs in', async (namespace) => {
    const keys = Promise.withResolvers<boolean>()
    const h = await harness({ status: 'signed-out', keys: () => keys.promise })
    h.refuse(namespace)
    keys.resolve(true)
    await vi.waitFor(() => { expect(h.controller.state.getSnapshot().status).toBe('error') })
    h.account.set(accountState('credential-stored'))
    expect(h.controller.state.getSnapshot()).toMatchObject({
      status: 'ready', visible: true, error: null, progress: { step: 'welcome', completion: null },
    })
    const writesBefore = h.mutate.mock.calls.length
    h.refuse()
    expect(await h.controller.retry()).toBe(false)
    expect(h.mutate).toHaveBeenCalledTimes(writesBefore)
    expect(await h.controller.complete('skipped')).toBe(false)
    expect(await h.controller.update({ step: 'credit' })).toBe(true)
  })

  it('requires welcome continuation and resumes saved progress after a controller restart', async () => {
    const h = await harness({ status: 'credential-stored' })
    expect(await h.controller.complete('skipped')).toBe(false)
    expect(await h.controller.update({ step: 'credit' })).toBe(true)
    h.controller.dispose()
    const resumed = new DesktopOnboardingController(h.progress, h.chat, h.setDeveloperTools, h.account, h.readKeys, h.mirror)
    cleanup.push(() => { resumed.dispose() })
    expect(resumed.state.getSnapshot()).toMatchObject({ visible: true, progress: { step: 'credit' } })
    h.account.set(accountState('signed-out'))
    expect(resumed.state.getSnapshot().visible).toBe(false)
    h.account.set(accountState('credential-stored'))
    expect(resumed.state.getSnapshot()).toMatchObject({ visible: true, progress: { step: 'credit' } })
  })

  it('accepts saved progress when the Host omits nullable defaults', async () => {
    const h = await harness({ status: 'credential-stored', omitNulls: true })
    expect(await h.controller.update({ step: 'credit' })).toBe(true)
    expect(h.data[DESKTOP_ONBOARDING_NAMESPACE]).not.toHaveProperty('purpose')
    expect(h.controller.state.getSnapshot()).toMatchObject({
      status: 'ready', error: null, progress: { step: 'credit', purpose: null, process: null, completion: null },
    })
  })

  it.each([
    ['office', null, 'compact', 'compact', false],
    ['development', 'compact', 'compact', 'detailed', true],
    ['development', 'standard', 'standard', 'detailed', true],
    ['both', 'detailed', 'detailed', 'detailed', true],
  ] as const)('applies %s / %s choices through the preference owners', async (purpose, process, transcriptView, usage, developerTools) => {
    const h = await harness({ status: 'credential-stored', progress: { step: 'process', purpose, process } })
    expect(await h.controller.complete('completed')).toBe(true)
    expect(h.data['ui-chat']).toEqual({ transcriptView, performanceUsage: usage })
    expect(h.data['ui-settings']).toEqual({ enabled: developerTools })
    expect(h.data[DESKTOP_ONBOARDING_NAMESPACE]).toMatchObject({ step: 'done', usage, developerTools, process: purpose === 'office' ? 'compact' : process })
  })

  it.each([
    ['purpose', 'standard'], ['credit', 'standard'], ['process', 'standard'],
  ] as const)('applies the shared skip defaults from %s', async (step, process) => {
    const h = await harness({ status: 'credential-stored', progress: { step, purpose: 'office', process: 'detailed' } })
    expect(await h.controller.complete('skipped')).toBe(true)
    expect(h.data['ui-chat']).toEqual({ transcriptView: 'standard', performanceUsage: 'compact' })
    expect(h.data['ui-settings']).toEqual({ enabled: false })
    expect(h.data[DESKTOP_ONBOARDING_NAMESPACE]).toMatchObject({ step: 'done', completion: 'skipped', process, usage: 'compact', developerTools: false })
  })

  it('records the preference defaults applied before onboarding completion', async () => {
    const results = []
    for (const purpose of ['office', 'development', 'both'] as const) {
      for (const process of ['compact', 'standard', 'detailed'] as const) {
        const h = await harness({ status: 'credential-stored', progress: { step: 'process', purpose, process } })
        expect(await h.controller.complete('completed')).toBe(true)
        results.push({ purpose, process, chat: h.data['ui-chat'], developer: h.data['ui-settings'] })
      }
    }
    await expect(JSON.stringify(results, null, 2) + '\n').toMatchFileSnapshot('./expected/onboarding-preferences.json')
  })

  it('requires a process choice before completing a developer path', async () => {
    const h = await harness({ status: 'credential-stored', progress: { step: 'process', purpose: 'development' } })
    expect(await h.controller.complete('completed')).toBe(false)
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('keeps progress visible after rejected settings writes and permits an explicit retry', async () => {
    const h = await harness({ status: 'credential-stored' })
    h.refuse(DESKTOP_ONBOARDING_NAMESPACE)
    expect(await h.controller.update({ step: 'credit' })).toBe(false)
    expect(h.controller.state.getSnapshot()).toMatchObject({ visible: true, status: 'error', progress: { step: 'welcome' } })
    h.refuse()
    expect(await h.controller.retry()).toBe(true)
    expect(h.controller.state.getSnapshot()).toMatchObject({ status: 'ready', progress: { step: 'credit' } })
  })

  it.each(['ui-chat', 'ui-settings', DESKTOP_ONBOARDING_NAMESPACE])('retries completion after %s persistence fails', async (namespace) => {
    const h = await harness({
      status: 'credential-stored', progress: { step: 'process', purpose: 'development', process: 'detailed' },
    })
    h.refuse(namespace)
    expect(await h.controller.complete('completed')).toBe(false)
    expect(h.controller.state.getSnapshot()).toMatchObject({ status: 'error', progress: { step: 'process' } })
    const writesBefore = h.mutate.mock.calls.length
    h.refuse()
    h.controller.invalidateCredentials()
    expect(h.mutate).toHaveBeenCalledTimes(writesBefore)
    expect(await h.controller.retry()).toBe(true)
    expect(h.mutate.mock.calls.slice(writesBefore).map(([ns]) => ns)).toEqual(['ui-chat', 'ui-settings', DESKTOP_ONBOARDING_NAMESPACE])
    expect(h.data['ui-chat']).toEqual({ transcriptView: 'detailed', performanceUsage: 'detailed' })
    expect(h.data['ui-settings']).toEqual({ enabled: true })
    expect(h.controller.state.getSnapshot()).toMatchObject({
      status: 'ready', visible: false,
      progress: { step: 'done', completion: 'completed', process: 'detailed', usage: 'detailed', developerTools: true },
    })
    expect(await h.controller.retry()).toBe(false)
  })

  it('discards an obsolete failed completion after a different choice succeeds', async () => {
    const h = await harness({ status: 'credential-stored', progress: { step: 'purpose', purpose: 'office' } })
    h.refuse(DESKTOP_ONBOARDING_NAMESPACE)
    expect(await h.controller.complete('completed')).toBe(false)
    h.refuse()
    expect(await h.controller.update({ purpose: 'development' })).toBe(true)
    expect(await h.controller.retry()).toBe(false)
    expect(h.controller.state.getSnapshot().progress).toMatchObject({ step: 'purpose', purpose: 'development', completion: null })
  })

  it('retains failed writes through repeated retries and refuses retries while saving, signed out, or disposed', async () => {
    const h = await harness({ status: 'credential-stored' })
    expect(await h.controller.retry()).toBe(false)
    h.refuse(DESKTOP_ONBOARDING_NAMESPACE)
    expect(await h.controller.update({ step: 'credit' })).toBe(false)
    expect(await h.controller.retry()).toBe(false)
    h.account.set(accountState('signed-out'))
    expect(await h.controller.retry()).toBe(false)
    h.account.set(accountState('credential-stored'))
    h.refuse()
    const write = Promise.withResolvers<undefined>()
    h.wait(write.promise)
    const pending = h.controller.retry()
    expect(await h.controller.retry()).toBe(false)
    expect(await h.controller.update({ step: 'purpose' })).toBe(false)
    write.resolve(undefined)
    expect(await pending).toBe(true)
    h.controller.dispose()
    expect(await h.controller.retry()).toBe(false)
  })

  it('never records completion when Chat preference persistence fails', async () => {
    const h = await harness({ status: 'credential-stored', progress: { step: 'process', purpose: 'development', process: 'standard' } })
    h.refuse('ui-chat')
    expect(await h.controller.complete('completed')).toBe(false)
    expect(h.data[DESKTOP_ONBOARDING_NAMESPACE]).toMatchObject({ step: 'process', completion: null })
  })

  it('previews consecutive selections and navigation while writes are pending', async () => {
    const h = await harness({ status: 'credential-stored' })
    const pending = Promise.withResolvers<undefined>()
    h.wait(pending.promise)
    const first = h.controller.update({ step: 'credit' })
    const second = h.controller.update({ step: 'purpose', purpose: 'office' })
    const third = h.controller.update({ purpose: 'both' })
    expect(h.controller.state.getSnapshot()).toMatchObject({ status: 'ready', progress: { step: 'purpose', purpose: 'both' } })
    pending.resolve(undefined)
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(await third).toBe(true)
    expect(h.data[DESKTOP_ONBOARDING_NAMESPACE]).toMatchObject({ step: 'purpose', purpose: 'both' })
  })

  it('waits for the latest selection before applying completion preferences', async () => {
    const h = await harness({ status: 'credential-stored', progress: { step: 'process', purpose: 'development' } })
    const pending = Promise.withResolvers<undefined>()
    h.wait(pending.promise)
    const first = h.controller.update({ process: 'compact' })
    const second = h.controller.update({ process: 'detailed' })
    const completion = h.controller.complete('completed')
    expect(h.controller.state.getSnapshot().status).toBe('saving')
    expect(await h.controller.update({ process: 'standard' })).toBe(false)
    pending.resolve(undefined)
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(await completion).toBe(true)
    expect(h.data['ui-chat']).toMatchObject({ transcriptView: 'detailed' })
  })

  it('restores saved progress after queued refusal and retries the latest choice', async () => {
    const h = await harness({ status: 'credential-stored', progress: { step: 'purpose' } })
    const pending = Promise.withResolvers<undefined>()
    h.wait(pending.promise)
    h.refuse(DESKTOP_ONBOARDING_NAMESPACE)
    const first = h.controller.update({ purpose: 'office' })
    const second = h.controller.update({ purpose: 'both', step: 'process' })
    const completion = h.controller.complete('skipped')
    pending.resolve(undefined)
    expect(await first).toBe(false)
    expect(await second).toBe(false)
    expect(await completion).toBe(false)
    expect(h.controller.state.getSnapshot()).toMatchObject({ status: 'error', progress: { step: 'purpose', purpose: null } })
    h.refuse(undefined)
    expect(await h.controller.retry()).toBe(true)
    expect(h.data[DESKTOP_ONBOARDING_NAMESPACE]).toMatchObject({ step: 'process', purpose: 'both' })
    expect(await h.controller.complete('skipped')).toBe(true)
  })

  it('does not write delayed API-key detection after disposal', async () => {
    const keys = Promise.withResolvers<boolean>()
    const h = await harness({ status: 'signed-out', keys: () => keys.promise })
    h.controller.dispose()
    keys.resolve(true)
    await keys.promise
    expect(h.mutate).not.toHaveBeenCalled()
  })
})

it('rejects unknown persisted steps and preference values at the Host schema', () => {
  expect(OnboardingSettingsSchema['~standard'].validate({ step: 'other' })).toHaveProperty('issues')
  expect(OnboardingSettingsSchema['~standard'].validate({ process: 'verbose' })).toHaveProperty('issues')
})

it('does not block the workspace when onboarding settings are read-only', async () => {
  const h = await harness({ status: 'credential-stored', writable: false })
  expect(h.controller.state.getSnapshot()).toMatchObject({ visible: false, status: 'error' })
})

it('does not keep a loading overlay after the initial account stream fails', async () => {
  const h = await harness()
  h.account.set({ ...accountState(), failed: true })
  expect(h.controller.state.getSnapshot()).toMatchObject({ visible: false, status: 'error' })
})

it('retries the initial settings read after a transport failure', async () => {
  let fail = true
  const h = await harness({ status: 'credential-stored', failRead: () => fail })
  expect(h.controller.state.getSnapshot()).toMatchObject({ visible: true, status: 'error', error: 'settings' })
  fail = false
  expect(await h.controller.retry()).toBe(true)
  expect(h.controller.state.getSnapshot()).toMatchObject({ visible: true, status: 'ready', error: null })
})

it('retries failed invisible API-key completion after credential invalidation', async () => {
  const keys = Promise.withResolvers<boolean>()
  const h = await harness({ status: 'signed-out', keys: () => keys.promise })
  h.refuse(DESKTOP_ONBOARDING_NAMESPACE)
  keys.resolve(true)
  await vi.waitFor(() => { expect(h.controller.state.getSnapshot().error).toBe('settings') })
  h.refuse()
  h.controller.invalidateCredentials()
  await vi.waitFor(() => { expect(h.controller.state.getSnapshot().progress.completion).toBe('api-key') })
})

it('keeps ordinary actions when restoring credit before its balance arrives', async () => {
  const h = await harness({ status: 'credential-stored', progress: { step: 'credit' } })
  expect(h.controller.state.getSnapshot()).toMatchObject({ status: 'ready', creditFunded: false })
  h.account.set({ ...h.account.getSnapshot(), details: { balance: {
    status: 'ready', bonusWallets: [], value: [{ currency: 'CNY', balance: '1' }],
  } } })
  expect(h.controller.state.getSnapshot()).toMatchObject({ status: 'ready', creditFunded: false })
})

it('refuses navigation before progress loads and after completion', async () => {
  const pending = Promise.withResolvers<undefined>()
  const h = await harness({ status: 'credential-stored', waitSettings: pending.promise })
  expect(await h.controller.update({ step: 'credit' })).toBe(false)
  expect(await h.controller.complete('completed')).toBe(false)
  pending.resolve(undefined)
  await h.loaded
  await h.controller.update({ step: 'credit' })
  await h.controller.complete('skipped')
  expect(await h.controller.update({ step: 'purpose' })).toBe(false)
  expect(await h.controller.complete('completed')).toBe(false)
})

it.each(['sign-out', 'dispose'] as const)('cancels completion before preferences start on %s', async (action) => {
  const h = await harness({ status: 'credential-stored', progress: { step: 'credit' } })
  const saved = h.controller.complete('skipped')
  if (action === 'dispose') h.controller.dispose()
  else h.account.set(accountState('signed-out'))
  expect(await saved).toBe(false)
  expect(h.mutate).not.toHaveBeenCalled()
})

it.each([
  ['sign-out', 'ui-chat'], ['dispose', 'ui-chat'],
  ['sign-out', 'ui-settings'], ['dispose', 'ui-settings'],
] as const)('stops preference completion after %s during a pending %s write', async (action, namespace) => {
  const h = await harness({ status: 'credential-stored', progress: { step: 'credit' } })
  const pending = Promise.withResolvers<undefined>()
  h.wait(pending.promise, namespace)
  const saved = h.controller.complete('skipped')
  await vi.waitFor(() => { expect(h.mutate.mock.calls.some(([ns]) => ns === namespace)).toBe(true) })
  if (action === 'dispose') h.controller.dispose()
  else h.account.set(accountState('signed-out'))
  pending.resolve(undefined)
  expect(await saved).toBe(false)
  expect(h.data[DESKTOP_ONBOARDING_NAMESPACE]).toMatchObject({ step: 'credit' })
})

it('does not persist a choice after disposal during the draft publication', async () => {
  const h = await harness({ status: 'credential-stored' })
  const off = h.controller.state.subscribe(() => {
    if (h.controller.state.getSnapshot().progress.step === 'credit') h.controller.dispose()
  })
  expect(await h.controller.update({ step: 'credit' })).toBe(false)
  off()
  expect(h.mutate).not.toHaveBeenCalled()
})

it.each(['current', 'invalidated', 'disposed'] as const)('contains a rejected %s credential query', async (state) => {
  const keys = Promise.withResolvers<boolean>()
  const h = await harness({ status: 'signed-out', keys: () => keys.promise })
  if (state === 'disposed') h.controller.dispose()
  if (state === 'invalidated') {
    h.readKeys.mockResolvedValueOnce(false)
    h.controller.invalidateCredentials()
  }
  keys.reject(new Error('metadata unavailable'))
  await keys.promise.catch(() => {})
  await Promise.resolve()
  expect(h.mutate).not.toHaveBeenCalled()
  expect(h.controller.state.getSnapshot().progress.step).toBe('welcome')
})
