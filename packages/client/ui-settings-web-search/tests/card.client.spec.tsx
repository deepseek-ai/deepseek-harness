// @vitest-environment jsdom
/** The web-search page as the Plugins page renders it: its API switch, key control, two fields, and their resets. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFieldState, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import { WebSearchCard, type WebSearchCardProps } from '../src/client/WebSearchCard.tsx'
import type { WebSearchCardState } from '../src/client/web-search-card-controller.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en) => en[key]

const settled: SettingsFormShell = { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }

function field(text: string, rest: Partial<SettingsFieldState> = {}): SettingsFieldState {
  return { text, overridden: false, invalid: false, ...rest }
}

const endpoints = {
  messages: field(''),
  api: field('https://api.deepseek.com/v1/tools'),
}

function cardActions() {
  return { edit: vi.fn(), resetField: vi.fn(), setSearchApi: vi.fn(), save: vi.fn(), discard: vi.fn() }
}

describe('WebSearchCard', () => {
  function renderWebSearch(state: Partial<WebSearchCardState> = {}) {
    const store = createSnapshotStore<WebSearchCardState>({
      ...settled,
      apiSwitchAvailable: true,
      apiSwitchBlocked: state.invalid === true || state.failed === true,
      baseURL: state.useSearchApi === true ? endpoints.api : endpoints.messages, useSearchApi: false, maxUses: field('5'),
      count: field('10'),
      apiKey: field(''),
      apiKeyConfigured: false,
      apiKeyWritable: true,
      ...state,
    })
    const actions = cardActions()
    const props = { ...actions, view: 'page', t, useWebSearchCard: bindSnapshotSelector(store) } as WebSearchCardProps
    render(<WebSearchCard {...props} />)
    return actions
  }

  it('renders its one-liner alone in the summary view', () => {
    const store = createSnapshotStore<WebSearchCardState>({
      ...settled, baseURL: endpoints.messages, apiSwitchAvailable: true, apiSwitchBlocked: false, useSearchApi: false,
      maxUses: field('5'), count: field('10'), apiKey: field(''), apiKeyConfigured: false, apiKeyWritable: true,
    })
    const props = { ...cardActions(), view: 'summary', t, useWebSearchCard: bindSnapshotSelector(store) } as WebSearchCardProps
    render(<WebSearchCard {...props} />)

    expect(document.body.textContent).toBe(en.description)
    expect(screen.queryByLabelText(en.apiKey)).toBeNull()
  })

  it('reports whether a key is configured without ever showing one', () => {
    renderWebSearch({ apiKeyConfigured: true })

    expect(screen.getByText(en.apiKeySet)).toBeTruthy()
    expect(screen.getByLabelText(en.apiKey)).toHaveProperty('type', 'password')
  })

  it('keeps the key control usable while the settings document is read-only', () => {
    const actions = renderWebSearch({ writable: false })

    const key = screen.getByLabelText(en.apiKey)
    expect(key).toHaveProperty('disabled', false)
    expect(screen.getByLabelText(en.baseUrl)).toHaveProperty('disabled', true)
    expect(screen.getByRole('switch', { name: en.useSearchApi })).toHaveProperty('disabled', true)

    fireEvent.change(key, { target: { value: 'ds-secret' } })

    expect(actions.edit).toHaveBeenCalledWith('apiKey', 'ds-secret')
  })

  it('disables the key control when the reference itself is not writable', () => {
    // A key coming from the process environment: the settings document is
    // writable, the credential is not.
    renderWebSearch({ apiKeyConfigured: true, apiKeyWritable: false })

    expect(screen.getByLabelText(en.apiKey)).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.baseUrl)).toHaveProperty('disabled', false)
  })

  it('stages the endpoint, the search budget, and their resets', () => {
    const actions = renderWebSearch({
      baseURL: { ...endpoints.messages, ...field('https://search.test/v1', { overridden: true }) },
      maxUses: field('3', { overridden: true }),
    })

    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://other.test' } })
    fireEvent.change(screen.getByLabelText(en.maxUses), { target: { value: '4' } })
    const resets = screen.getAllByRole('button', { name: en.reset })
    expect(resets).toHaveLength(2)
    for (const reset of resets) fireEvent.click(reset)

    expect(actions.edit.mock.calls).toEqual([
      ['baseURL', 'https://other.test'],
      ['maxUses', '4'],
    ])
    expect(actions.resetField.mock.calls).toEqual([['baseURL'], ['maxUses']])
  })
  it.each([
    [false, en.baseUrl, ''],
    [true, en.searchApiBaseUrl, 'https://api.deepseek.com/v1/tools'],
  ])('shows the selected API endpoint with the Search API %s and offers no reset before an override', (searchApi, label, value) => {
    const actions = renderWebSearch({ useSearchApi: searchApi })
    const input = screen.getByLabelText(label)
    expect(input).toHaveProperty('value', value)
    expect(screen.queryByText(en.overridden)).toBeNull()
    expect(screen.queryByRole('button', { name: en.reset })).toBeNull()
    fireEvent.change(input, { target: { value: 'https://custom.test' } })
    expect(actions.edit).toHaveBeenCalledWith('baseURL', 'https://custom.test')
  })

  it('defaults the feature off and stages enabling it', () => {
    const actions = renderWebSearch()
    const toggle = screen.getByRole('switch', { name: en.useSearchApi })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByLabelText(en.maxUses)).toBeTruthy()
    expect(screen.getByText(en.baseUrlHint)).toBeTruthy()
    expect(screen.queryByText(en.searchApiBaseUrlHint)).toBeNull()
    expect(zh.useSearchApi).toBe('启用新版 Web 搜索 API')
    fireEvent.click(toggle)
    expect(actions.setSearchApi).toHaveBeenCalledWith(true)
    expect(actions.save).not.toHaveBeenCalled()
  })

  it('links the switch hint to the localized search and fetch guide', () => {
    renderWebSearch()
    const guide = screen.getByRole('link', { name: en.searchGuide })
    expect(guide).toHaveProperty('href', en.searchGuideUrl)
    expect(guide.getAttribute('target')).toBe('_blank')
    expect(guide.getAttribute('rel')).toBe('noopener noreferrer')
    expect(guide.parentElement?.textContent).toBe(`${en.useSearchApiHint}${en.searchGuide}`)
    expect(`${zh.useSearchApiHint}${zh.searchGuide}`).toBe('默认关闭，搜索通过 DeepSeek Messages 完成。新版 Web 搜索 API 功能与计费详见网页搜索与抓取指南')
    expect(zh.searchGuideUrl).toBe('https://api-docs.deepseek.com/zh-cn/guides/search')
  })

  it('omits the switch while the Host serves no Search and Fetch API section', () => {
    renderWebSearch({ apiSwitchAvailable: false })
    expect(screen.queryByRole('switch', { name: en.useSearchApi })).toBeNull()
    expect(screen.queryByRole('link', { name: en.searchGuide })).toBeNull()
    expect(screen.getByLabelText(en.maxUses)).toBeTruthy()
  })

  it.each([{ invalid: true }, { failed: true }, { saving: true }])('keeps invalid or unsaved failures visible while the switch is locked: %j', (state) => {
    renderWebSearch(state)
    expect(screen.getByRole('switch', { name: en.useSearchApi })).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.maxUses)).toBeTruthy()
  })

  it('explains the supported result count and blocks saving an invalid draft', () => {
    renderWebSearch({ useSearchApi: true, count: field('51', { invalid: true }), invalid: true, dirty: true })
    expect(screen.getByText(en.invalidCount)).toBeTruthy()
    expect(screen.getByLabelText(en.count).getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
  })

  it('edits the Search API endpoint and result count in Search API mode', () => {
    const actions = renderWebSearch({ useSearchApi: true, count: field('20', { overridden: true }) })
    expect(screen.queryByLabelText(en.maxUses)).toBeNull()
    expect(screen.getByLabelText(en.count)).toHaveProperty('value', '20')
    expect(screen.getByText(en.countHint)).toBeTruthy()
    expect(screen.getByText(en.searchApiBaseUrlHint)).toBeTruthy()
    expect(screen.queryByText(en.baseUrlHint)).toBeNull()
    expect(screen.getByLabelText(en.searchApiBaseUrl)).toHaveProperty('value', 'https://api.deepseek.com/v1/tools')
    fireEvent.change(screen.getByLabelText(en.searchApiBaseUrl), { target: { value: 'https://other.test' } })
    fireEvent.change(screen.getByLabelText(en.count), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: en.reset }))
    fireEvent.click(screen.getByRole('switch', { name: en.useSearchApi }))
    expect(actions.edit.mock.calls).toEqual([['baseURL', 'https://other.test'], ['count', '30']])
    expect(actions.resetField.mock.calls).toEqual([['count']])
    expect(actions.setSearchApi).toHaveBeenCalledWith(false)
  })
})
