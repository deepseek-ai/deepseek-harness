// @vitest-environment jsdom
/** Preferences remain staged until one explicit Settings save. */
import type { TranslationProvider } from '@deepseek-ai/dsh-experimental-translator/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { TranslationPreferencesForm } from '../src/client/preferences-form.ts'
import { TranslationSettings, type TranslationSettingsProps } from '../src/client/TranslationSettings.tsx'
import type { CotTranslationPreferences } from '../src/preferences.ts'
import { en, zh, formLabels } from '../src/client/locales.ts'

afterEach(cleanup)

it('stages provider and language together, rejects malformed codes, and resets the language', async () => {
  const scope = stubConfigForm<CotTranslationPreferences>()
  scope.publish({ status: 'ready', value: { provider: 'bing', targetLanguage: 'auto' },
    base: { provider: 'bing', targetLanguage: 'auto' }, user: {}, writable: true, revision: 7 })
  const form = new TranslationPreferencesForm(scope.scope), { hooks, ...actions } = form.inject()
  const props = { view: 'page' as const, ...actions,
    refreshProviders: vi.fn(), useAvailableProviders: bindSnapshotSelector(
      createSnapshotStore<readonly TranslationProvider[]>(['bing', 'google'])), useTranslationForm: bindSnapshotSelector(hooks.translationForm),
    t: ((key: keyof typeof en) => en[key]) } as TranslationSettingsProps
  const view = render(<TranslationSettings {...props} />)
  expect(view.getByLabelText(en.provider)).toHaveProperty('value', 'bing')
  expect(view.getByLabelText(en.targetLanguage)).toHaveProperty('value', 'auto')
  expect(view.getByText(en.privacy)).toBeTruthy()
  fireEvent.change(view.getByLabelText(en.provider), { target: { value: 'google' } })
  fireEvent.change(view.getByLabelText(en.targetLanguage), { target: { value: 'invalid code!' } })
  expect(view.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
  expect(scope.mutate).not.toHaveBeenCalled()
  fireEvent.change(view.getByLabelText(en.targetLanguage), { target: { value: 'zh-Hant' } })
  fireEvent.click(view.getByRole('button', { name: en.save }))
  await vi.waitFor(() => { expect(scope.mutate).toHaveBeenCalledWith([
    { op: 'set', path: ['provider'], value: 'google' }, { op: 'set', path: ['targetLanguage'], value: 'zh-Hant' },
  ], 7) })
  fireEvent.change(view.getByLabelText(en.targetLanguage), { target: { value: 'ja' } })
  fireEvent.click(view.getAllByRole('button', { name: en.reset }).at(-1)!)
  expect(view.getByLabelText(en.targetLanguage)).toHaveProperty('value', 'auto')
  view.unmount()
  form.dispose()
  expect(scope.listenerCount()).toBe(0)
})

it('uses the shared unavailable and read-only states and supplies both dictionaries', () => {
  const scope = stubConfigForm<CotTranslationPreferences>()
  const form = new TranslationPreferencesForm(scope.scope), { hooks, ...actions } = form.inject()
  try {
    expect(Object.keys(en)).toEqual(Object.keys(zh))
    expect(formLabels(makeTranslate(zh)).save).toBe('保存')
    const props = { view: 'page' as const, ...actions,
      refreshProviders: vi.fn(), useAvailableProviders: bindSnapshotSelector(
        createSnapshotStore<readonly TranslationProvider[]>(['bing', 'google'])), useTranslationForm: bindSnapshotSelector(hooks.translationForm),
      t: ((key: keyof typeof en) => en[key]) } as TranslationSettingsProps
    const view = render(<TranslationSettings {...props} />)
    expect(view.getByText(en.unavailable)).toBeTruthy()
    scope.publish({ status: 'ready', value: { provider: 'bing', targetLanguage: 'auto' } })
    view.rerender(<TranslationSettings {...props} />)
    expect(view.getByText(en.readOnly)).toBeTruthy()
    expect(view.getByLabelText(en.provider)).toHaveProperty('disabled', true)
  } finally { form.dispose() }
})


it('reports provider overrides, rejects an invalid draft, and resets to the inherited choice', async () => {
  const scope = stubConfigForm<CotTranslationPreferences>()
  scope.publish({ status: 'ready', value: { provider: 'google', targetLanguage: 'auto' },
    base: { provider: 'bing', targetLanguage: 'auto' }, user: { provider: 'google' }, writable: true, revision: 3 })
  const form = new TranslationPreferencesForm(scope.scope), { hooks, ...actions } = form.inject()
  const props = { view: 'page' as const, ...actions,
    refreshProviders: vi.fn(), useAvailableProviders: bindSnapshotSelector(
      createSnapshotStore<readonly TranslationProvider[]>(['bing', 'google'])), useTranslationForm: bindSnapshotSelector(hooks.translationForm),
    t: ((key: keyof typeof en) => en[key]) } as TranslationSettingsProps
  const view = render(<TranslationSettings {...props} />)
  try {
    expect(view.getByText(en.overridden)).toBeTruthy()
    expect(view.getByRole('button', { name: en.reset })).toBeTruthy()
    actions.edit('provider', 'bing')
    expect(hooks.translationForm.getSnapshot().invalid).toBe(false)
    actions.edit('provider', 'unsupported')
    view.rerender(<TranslationSettings {...props} />)
    expect(view.getByText(en.invalidProvider)).toBeTruthy()
    expect(view.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    actions.discard()
    view.rerender(<TranslationSettings {...props} />)
    fireEvent.click(view.getByRole('button', { name: en.reset }))
    expect(view.getByLabelText(en.provider)).toHaveProperty('value', 'bing')
    fireEvent.click(view.getByRole('button', { name: en.save }))
    await vi.waitFor(() => { expect(scope.mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['provider'] }], 3) })
    actions.edit('provider', '')
    expect(hooks.translationForm.getSnapshot().invalid).toBe(false)
  } finally { view.unmount(); form.dispose() }
})


it('offers both version-free paid routes only when eligible and keeps selection staged until Save', async () => {
  const scope = stubConfigForm<CotTranslationPreferences>()
  scope.publish({ status: 'ready', value: { provider: 'bing', targetLanguage: 'auto' },
    base: { provider: 'bing', targetLanguage: 'auto' }, user: {}, writable: true, revision: 4 })
  const form = new TranslationPreferencesForm(scope.scope), { hooks, ...actions } = form.inject()
  const availability = createSnapshotStore<readonly TranslationProvider[]>(['bing', 'google', 'deepseek-account', 'deepseek-official'])
  const refreshProviders = vi.fn(), t: TranslationSettingsProps['t'] = makeTranslate(en)
  const props = { view: 'page' as const, ...actions, useTranslationForm: bindSnapshotSelector(hooks.translationForm),
    useAvailableProviders: bindSnapshotSelector(availability), refreshProviders, t } as TranslationSettingsProps
  const view = render(<TranslationSettings {...props} />)
  try {
    expect(refreshProviders).toHaveBeenCalledOnce()
    expect(view.getByLabelText(en.provider)).toHaveProperty('value', 'bing')
    expect(view.getByRole('option', { name: en.deepseekAccount })).toBeTruthy()
    expect(view.getByRole('option', { name: en.deepseekOfficial })).toBeTruthy()
    expect(en.deepseekAccount).not.toMatch(/v?4\.1/)
    expect(view.getByText(en.anonymousNotice)).toBeTruthy()
    expect(view.queryByText(en.paidNotice)).toBeNull()
    fireEvent.change(view.getByLabelText(en.provider), { target: { value: 'deepseek-account' } })
    expect(view.getByText(en.paidNotice)).toBeTruthy()
    expect(en.paidNotice).toContain('Each uncached fragment sends a separate paid')
    expect(en.paidNotice).toContain('Reopening reasoning reuses saved results')
    expect(zh.paidNotice).toContain('每个未缓存片段')
    expect(zh.paidNotice).toContain('重新展开会复用已保存的译文')
    expect(view.queryByText(en.anonymousNotice)).toBeNull()
    expect(scope.mutate).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: en.save }))
    await vi.waitFor(() => { expect(scope.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['provider'], value: 'deepseek-account' }], 4) })
    fireEvent.change(view.getByLabelText(en.provider), { target: { value: 'deepseek-official' } })
    expect(hooks.translationForm.getSnapshot().invalid).toBe(false)
    expect(view.getByText(en.paidNotice)).toBeTruthy()
  } finally { view.unmount(); form.dispose() }
})

it('keeps an unavailable paid choice disabled and offers repair or an explicit reset without selecting a free fallback', () => {
  const scope = stubConfigForm<CotTranslationPreferences>()
  scope.publish({ status: 'ready', value: { provider: 'deepseek-official', targetLanguage: 'auto' },
    base: { provider: 'bing', targetLanguage: 'auto' }, user: { provider: 'deepseek-official' }, writable: true, revision: 6 })
  const form = new TranslationPreferencesForm(scope.scope), { hooks, ...actions } = form.inject()
  const availability = createSnapshotStore<readonly TranslationProvider[]>(['bing', 'google'])
  const t: TranslationSettingsProps['t'] = makeTranslate(en)
  const props = { view: 'page' as const, ...actions, useTranslationForm: bindSnapshotSelector(hooks.translationForm),
    useAvailableProviders: bindSnapshotSelector(availability), refreshProviders: vi.fn(), t } as TranslationSettingsProps
  const view = render(<TranslationSettings {...props} />)
  try {
    expect(view.getByLabelText(en.provider)).toHaveProperty('value', 'deepseek-official')
    const selected = view.getByRole('option', { name: `${en.deepseekOfficial} — unavailable` })
    expect(selected).toHaveProperty('disabled', true)
    expect(view.queryByRole('option', { name: en.deepseekAccount })).toBeNull()
    expect(view.getByText(en.providerUnavailable)).toBeTruthy()
    expect(view.getByText(en.paidNotice)).toBeTruthy()
    expect(scope.mutate).not.toHaveBeenCalled()
    act(() => { availability.set(['bing', 'google', 'deepseek-official']) })
    expect(view.getByLabelText(en.provider)).toHaveProperty('value', 'deepseek-official')
    expect(view.getByRole('option', { name: en.deepseekOfficial })).toHaveProperty('disabled', false)
    expect(view.queryByText(en.providerUnavailable)).toBeNull()
    expect(scope.mutate).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: en.reset }))
    expect(view.getByLabelText(en.provider)).toHaveProperty('value', 'bing')
    expect(view.getByText(en.anonymousNotice)).toBeTruthy()
  } finally { view.unmount(); form.dispose() }
})
