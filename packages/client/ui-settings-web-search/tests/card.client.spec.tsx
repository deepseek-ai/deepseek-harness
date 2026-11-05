// @vitest-environment jsdom
/** The web search and fetch page as the Plugins page renders it: two provider menus and the selected providers' own settings. */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFieldState, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import { WebSearchCard, type WebSearchCardProps } from '../src/client/WebSearchCard.tsx'
import type { WebProviderOption, WebSearchCardState } from '../src/client/web-search-card-controller.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: keyof typeof en, params?: Record<string, unknown>) =>
  en[key].replace(/\{(\w+)\}/g, (match, name: string) => params !== undefined && name in params ? String(params[name]) : match)) as WebSearchCardProps['t']

const settled: SettingsFormShell = { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }

function field(text: string, rest: Partial<SettingsFieldState> = {}): SettingsFieldState {
  return { text, overridden: false, invalid: false, ...rest }
}

/** Each official provider's registered description; the page shows the active language's entry. */
const DESCRIPTIONS: Record<string, { en: string; zh: string }> = {
  'deepseek-search-api': {
    en: 'Search API description. Incurs charges, billed to the DeepSeek account or DeepSeek API key that the Billing setting selects.',
    zh: 'Search API 说明。会产生费用，按「计费方式」向 DeepSeek 账号或 DeepSeek API Key 计费。',
  },
  'http': { en: 'Direct fetch description.', zh: '本机获取说明' },
  'deepseek-fetch-api': {
    en: 'Fetch API description. Incurs charges, billed to the DeepSeek account or DeepSeek API key that the Billing setting selects.',
    zh: 'Fetch API 说明。会产生费用，按「计费方式」向 DeepSeek 账号或 DeepSeek API Key 计费。',
  },
}

function options(...ids: string[]): WebProviderOption[] {
  return ids.map(id => ({ id, ...DESCRIPTIONS[id] === undefined ? {} : { description: DESCRIPTIONS[id] }, missing: false }))
}

/** Menu entries as the controller orders them. */
const SEARCH_OPTIONS = options('deepseek-search-api', 'deepseek-official')
const FETCH_OPTIONS = options('http', 'deepseek-fetch-api')

/** The locale service's resolution, with Chinese active. */
const resolveText = vi.fn((text: string | { en: string; [locale: string]: string }) => typeof text === 'string' ? text : text.zh ?? text.en)

/** The shipped selection: the DeepSeek Search API with local fetch. */
function shipped(): WebSearchCardState {
  return {
    ...settled,
    selectionBlocked: false,
    providersFailed: false,
    search: { selected: 'deepseek-search-api', options: SEARCH_OPTIONS, kind: 'deepseek', auto: false },
    fetch: { selected: 'http', options: FETCH_OPTIONS, kind: 'local', auto: false },
    count: field('10'),
    searchBilling: { value: 'auto', overridden: false, advancedOverride: [] },
    fetchBilling: undefined,
    messagesBaseURL: field(''),
    maxUses: field('5'),
    legacyKey: undefined,
  }
}

/** Both DeepSeek API providers selected. */
function apis(): WebSearchCardState {
  const base = shipped()
  return {
    ...base, fetch: { ...base.fetch, selected: 'deepseek-fetch-api', kind: 'deepseek' }, fetchBilling: { value: 'account', overridden: true, advancedOverride: [] },
  }
}

/** Legacy Messages search selected, with its key control. */
function legacy(key: Partial<NonNullable<WebSearchCardState['legacyKey']>> = {}): WebSearchCardState {
  const base = shipped()
  return {
    ...base,
    search: { ...base.search, selected: 'deepseek-official', kind: 'legacy' },
    searchBilling: undefined,
    legacyKey: { ...field(''), ref: 'DEEPSEEK_API_KEY', configured: false, writable: true, ...key },
  }
}

/** Search and Fetch providers that take no settings on this page. */
function plugins(): WebSearchCardState {
  const base = shipped()
  return {
    ...base,
    search: { selected: 'exa', kind: 'plugin', auto: false, options: [{ id: 'exa', title: 'Exa', missing: false }] },
    fetch: { selected: '', kind: 'none', auto: false, options: [] },
    searchBilling: undefined,
  }
}

function cardActions() {
  return {
    edit: vi.fn(), resetField: vi.fn(), selectProvider: vi.fn(), selectBilling: vi.fn(), retryProviders: vi.fn(), save: vi.fn(),
    discard: vi.fn(),
  }
}

function renderPage(state: WebSearchCardState = shipped(), view: 'page' | 'summary' = 'page') {
  const store = createSnapshotStore<WebSearchCardState>(state)
  const actions = cardActions()
  const props = { ...actions, view, t, resolveText, useWebSearchCard: bindSnapshotSelector(store) } as WebSearchCardProps
  render(<WebSearchCard {...props} />)
  return { actions, store }
}

/** The provider menus, named by their section title followed by the selected provider. */
const searchMenu = () => screen.getByRole('button', { name: new RegExp(`^${en.searchSection} `) })
const fetchMenu = () => screen.getByRole('button', { name: new RegExp(`^${en.fetchSection} `) })
const region = (name: string) => within(screen.getByRole('region', { name }))
/** The text of every paragraph in a section, in order. */
const paragraphs = (name: string) => [...screen.getByRole('region', { name }).querySelectorAll('p')].map(node => node.textContent)

/** The billing menu of a section, named by its label followed by the selected billing. */
const billingMenu = (name: string) => region(name).getByRole('button', { name: new RegExp(`^${en.billing} `) })

describe('WebSearchCard billing', () => {
  it('shows each DeepSeek API billing menu with the selected billing and its explanation', () => {
    renderPage(apis())
    expect(billingMenu(en.searchSection).textContent).toBe('Automatic')
    expect(billingMenu(en.fetchSection).textContent).toBe('Signed-in DeepSeek account')
    expect(region(en.searchSection).getByText(
      "Follows the conversation's DeepSeek account or API key; with other models, uses the API key first, then the signed-in account.",
      { exact: true },
    )).toBeTruthy()
    expect(region(en.fetchSection).getByText('Requires signing in to DeepSeek.', { exact: true }))
      .toBeTruthy()
    expect(screen.queryByText(/^Overridden by /)).toBeNull()
  })

  it.each<[string, readonly string[], string]>([
    ['one own field', ['searchBaseURL'], 'Overridden by searchBaseURL'],
    // The page's resolver picks Chinese, so two names join with the Chinese enumeration comma.
    ['both own fields', ['searchBaseURL', 'searchApiKeyEnv'], 'Overridden by searchBaseURL、searchApiKeyEnv'],
  ])('tags the billing with %s and locks its menu', (_label, advancedOverride, tag) => {
    renderPage({ ...apis(), searchBilling: { value: 'auto', overridden: false, advancedOverride } })
    expect(region(en.searchSection).getByText(tag, { exact: true })).toBeTruthy()
    expect((billingMenu(en.searchSection) as HTMLButtonElement).disabled).toBe(true)
    expect(region(en.fetchSection).queryByText(/^Overridden by /)).toBeNull()
    expect((billingMenu(en.fetchSection) as HTMLButtonElement).disabled).toBe(false)
  })

  it('joins the overriding field names with the separator of the active language', () => {
    renderPage({ ...apis(), fetchBilling: { value: 'auto', overridden: false, advancedOverride: ['fetchBaseURL', 'fetchApiKeyEnv'] } })
    expect(resolveText).toHaveBeenCalledWith(expect.objectContaining({ en: ', ', zh: '、' }))
    expect(region(en.fetchSection).getByText('Overridden by fetchBaseURL、fetchApiKeyEnv', { exact: true })).toBeTruthy()
  })

  it('lists the three billings and selects a new one for its capability only', () => {
    const { actions } = renderPage(apis())
    fireEvent.click(billingMenu(en.fetchSection))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent))
      .toEqual(['Automatic', 'Signed-in DeepSeek account', 'DeepSeek API key'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'DeepSeek API key' }))
    fireEvent.click(billingMenu(en.searchSection))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Automatic' }))
    expect(actions.selectBilling.mock.calls).toEqual([['fetch', 'api-key']])
  })

  it('explains API-key billing', () => {
    renderPage({ ...shipped(), searchBilling: { value: 'api-key', overridden: true, advancedOverride: [] } })
    expect(billingMenu(en.searchSection).textContent).toBe('DeepSeek API key')
    expect(region(en.searchSection).getByText('Uses the API key from the Models page; set one first.', { exact: true }))
      .toBeTruthy()
  })

  it('shows no billing menu for local fetch, legacy search, or plugin providers', () => {
    renderPage(legacy())
    expect(screen.queryByRole('button', { name: new RegExp(`^${en.billing} `) })).toBeNull()
    cleanup()
    renderPage(plugins())
    expect(screen.queryByRole('button', { name: new RegExp(`^${en.billing} `) })).toBeNull()
  })

  it('locks the billing menus while settings are read-only or saving', () => {
    renderPage({ ...apis(), writable: false })
    expect((billingMenu(en.searchSection) as HTMLButtonElement).disabled).toBe(true)
    expect((billingMenu(en.fetchSection) as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    renderPage({ ...apis(), saving: true })
    expect((billingMenu(en.fetchSection) as HTMLButtonElement).disabled).toBe(true)
  })

  it('carries the approved billing copy in both locales', () => {
    expect([en.billing, en.billingAuto, en.billingAccount, en.billingApiKey])
      .toEqual(['Billing', 'Automatic', 'Signed-in DeepSeek account', 'DeepSeek API key'])
    expect([zh.billing, zh.billingAuto, zh.billingAccount, zh.billingApiKey])
      .toEqual(['计费方式', '自动', '已登录的 DeepSeek 账号', 'DeepSeek API Key'])
    expect([zh.billingAutoHint, zh.billingAccountHint, zh.billingApiKeyHint, zh.billingAdvancedOverride]).toEqual([
      '跟随当前会话的 DeepSeek 账号或 API Key；会话用其他模型时，优先用 API Key，没有则用已登录账号。',
      '需要先登录 DeepSeek 账号。',
      '使用「模型」页配置的 API Key，需要先配置。',
      '已被 {fields} 覆盖',
    ])
    expect([en.billingAutoHint, en.billingAccountHint, en.billingApiKeyHint, en.billingAdvancedOverride]).toEqual([
      "Follows the conversation's DeepSeek account or API key; with other models, uses the API key first, then the signed-in account.",
      'Requires signing in to DeepSeek.',
      'Uses the API key from the Models page; set one first.',
      'Overridden by {fields}',
    ])
  })
})

describe('WebSearchCard', () => {
  it('offers legacy search in both locales and renders its own settings', () => {
    const { actions } = renderPage(legacy())
    expect(searchMenu().textContent).toBe('DeepSeek (legacy)')
    expect(zh.providerLegacy).toBe('DeepSeek（旧版）')
    expect(screen.queryByLabelText(en.count)).toBeNull()
    fireEvent.change(screen.getByLabelText(en.credential), { target: { value: 'new-key' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://messages.test/v1' } })
    fireEvent.change(screen.getByLabelText(en.maxUses), { target: { value: '8' } })
    expect(actions.edit.mock.calls).toEqual([
      ['legacyApiKey', 'new-key'], ['messagesBaseURL', 'https://messages.test/v1'], ['maxUses', '8'],
    ])
  })

  it('resets the legacy endpoint and search limit under their own names', () => {
    const { actions } = renderPage({
      ...legacy(), messagesBaseURL: field('https://messages.test/v1', { overridden: true }), maxUses: field('8', { overridden: true }),
    })
    for (const button of screen.getAllByRole('button', { name: en.reset })) fireEvent.click(button)
    expect(actions.resetField.mock.calls).toEqual([['messagesBaseURL'], ['maxUses']])
  })

  it('renders its one-liner alone in the summary view', () => {
    renderPage(shipped(), 'summary')
    expect(document.body.textContent).toBe(en.description)
    expect(screen.queryByLabelText(en.count)).toBeNull()
  })

  it('titles the page and its two sections by the provider each one picks', () => {
    renderPage()
    expect(en.title).toBe('Web search and fetch')
    expect(zh.title).toBe('网页搜索与获取')
    expect([en.searchSection, en.fetchSection]).toEqual(['Web search provider', 'Web fetch provider'])
    expect([zh.searchSection, zh.fetchSection]).toEqual(['网页搜索提供方', '网页获取提供方'])
    expect(screen.getByRole('heading', { name: en.searchSection })).toBeTruthy()
    expect(screen.getByRole('heading', { name: en.fetchSection })).toBeTruthy()
    expect(screen.getByRole('region', { name: en.searchSection })).toBeTruthy()
    expect(screen.getByRole('region', { name: en.fetchSection })).toBeTruthy()
  })

  it('names each provider menu by its section title and the selected provider, with no label of its own', () => {
    renderPage()
    expect(searchMenu().getAttribute('aria-labelledby')).toBe('plugin-config-web-search-section plugin-config-web-search-provider-value')
    expect(screen.getByRole('button', { name: `${en.searchSection} ${en.providerDeepSeek}` })).toBe(searchMenu())
    expect(screen.getByRole('button', { name: `${en.fetchSection} ${en.providerLocal}` })).toBe(fetchMenu())
    for (const title of [en.searchSection, en.fetchSection]) expect(screen.getAllByText(title)).toHaveLength(1)
    expect(document.querySelectorAll('label[for="plugin-config-web-search-provider"], label[for="plugin-config-web-fetch-provider"]')).toHaveLength(0)
  })

  it('shows the Search API result count in a panel, and gives local fetch no panel', () => {
    renderPage()
    expect(searchMenu().textContent).toBe(en.providerDeepSeek)
    expect(fetchMenu().textContent).toBe(en.providerLocal)
    expect(region(en.searchSection).getByText(DESCRIPTIONS['deepseek-search-api']!.zh)).toBeTruthy()
    expect(region(en.fetchSection).getByText('本机获取说明')).toBeTruthy()
    expect(region(en.searchSection).getByLabelText(en.count)).toHaveProperty('value', '10')
    for (const label of [en.credential, en.baseUrl]) expect(screen.queryByLabelText(label)).toBeNull()
    expect(region(en.fetchSection).queryByRole('textbox')).toBeNull()
  })

  it('shows the DeepSeek Fetch API description under its provider menu, and its billing panel after it', () => {
    renderPage(apis())
    expect(fetchMenu().textContent).toBe(en.providerDeepSeekFetch)
    expect(region(en.fetchSection).getByText(DESCRIPTIONS['deepseek-fetch-api']!.zh)).toBeTruthy()
    expect(screen.getAllByRole('button').filter(button => button.hasAttribute('aria-expanded')).map(button => button.id)).toEqual([
      'plugin-config-web-search-provider', 'plugin-config-web-search-billing',
      'plugin-config-web-fetch-provider', 'plugin-config-web-fetch-billing',
    ])
    // The Fetch section holds its title, its provider menu block, and the billing panel.
    expect(screen.getByRole('region', { name: en.fetchSection }).children).toHaveLength(3)
    expect(region(en.fetchSection).queryByRole('textbox')).toBeNull()
  })

  it('edits and resets the Search API result count', () => {
    const { actions } = renderPage({ ...apis(), count: field('20', { overridden: true }) })
    const search = region(en.searchSection)
    expect(search.getByLabelText(en.count)).toHaveProperty('value', '20')
    fireEvent.change(search.getByLabelText(en.count), { target: { value: '30' } })
    fireEvent.click(search.getByRole('button', { name: en.reset }))
    expect(actions.edit.mock.calls).toEqual([['count', '30']])
    expect(actions.resetField.mock.calls).toEqual([['count']])
  })

  it('shows the DeepSeek search guide after the Search API description, and the Fetch API description', () => {
    renderPage(apis())
    expect(fetchMenu().textContent).toBe(en.providerDeepSeekFetch)
    const guide = screen.getByRole('link', { name: en.searchGuide })
    expect(guide).toHaveProperty('href', en.searchGuideUrl)
    expect(guide.getAttribute('target')).toBe('_blank')
    expect(guide.getAttribute('rel')).toBe('noopener noreferrer')
    // The description comes first; the guide link is the page's own line after it.
    expect(paragraphs(en.searchSection).slice(0, 2)).toEqual([DESCRIPTIONS['deepseek-search-api']!.zh, en.searchGuide])
  })

  it('shows no settings while neither provider takes them', () => {
    renderPage(plugins())
    expect(screen.queryByText(en.credential)).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('selects a provider from the menu and leaves the current one alone', () => {
    const { actions } = renderPage()
    fireEvent.click(searchMenu())
    expect(searchMenu().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([en.providerDeepSeek, en.providerLegacy])
    fireEvent.click(screen.getByRole('menuitem', { name: en.providerDeepSeek }))
    expect(screen.queryByRole('menuitem')).toBeNull()
    fireEvent.click(fetchMenu())
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([en.providerLocal, en.providerDeepSeekFetch])
    fireEvent.click(screen.getByRole('menuitem', { name: en.providerLocal }))
    expect(actions.selectProvider).not.toHaveBeenCalled()
    fireEvent.click(fetchMenu())
    fireEvent.click(screen.getByRole('menuitem', { name: en.providerDeepSeekFetch }))
    expect(actions.selectProvider).toHaveBeenLastCalledWith('fetchProvider', 'deepseek-fetch-api')
    expect(actions.save).not.toHaveBeenCalled()
  })

  it('shows each selected provider’s registered description as plain text, with no action of its own', () => {
    renderPage()
    expect(region(en.fetchSection).getByText('本机获取说明').tagName).toBe('P')
    expect(region(en.fetchSection).queryAllByRole('button').map(button => button.id)).toEqual(['plugin-config-web-fetch-provider'])
    expect(resolveText).toHaveBeenCalledWith(DESCRIPTIONS.http)
  })

  it('shows a plugin provider’s description before the pointer to its own settings, and nothing for a provider without one', () => {
    const base = plugins()
    renderPage({
      ...base,
      search: { ...base.search, options: [{ id: 'exa', title: 'Exa', description: { en: 'Exa search.', zh: 'Exa 搜索' }, missing: false }] },
      fetch: { ...base.fetch, selected: 'jina', kind: 'plugin', options: [{ id: 'jina', description: { en: 'Jina.', zh: '' }, missing: false }] },
    })
    expect(paragraphs(en.searchSection)).toEqual(['Exa 搜索', en.pluginProviderHint])
    // An empty translation shows no paragraph.
    expect(paragraphs(en.fetchSection)).toEqual([en.pluginProviderHint])
  })

  it('closes an open menu without selecting on Escape', () => {
    const { actions } = renderPage()
    fireEvent.click(searchMenu())
    fireEvent.keyDown(screen.getAllByRole('menuitem')[0]!, { key: 'Escape' })
    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(actions.selectProvider).not.toHaveBeenCalled()
  })

  it('names plugin providers by title or id, and marks a selection the Host does not register', () => {
    const base = shipped()
    renderPage({
      ...base,
      search: {
        selected: 'perplexity', kind: 'none', auto: false,
        options: [...SEARCH_OPTIONS, { id: 'exa', title: 'Exa', missing: false }, { id: 'perplexity', missing: true }],
      },
      fetch: {
        selected: 'jina', kind: 'plugin', auto: false,
        options: [...FETCH_OPTIONS, { id: 'jina', missing: false }],
      },
    })
    expect(searchMenu().textContent).toBe('perplexity (not loaded)')
    expect(zh.providerMissing).toBe('{id}（未加载）')
    expect(fetchMenu().textContent).toBe('jina')
    expect(screen.getAllByText(en.pluginProviderHint)).toHaveLength(1)
    expect(screen.queryByText(en.credential)).toBeNull()
    fireEvent.click(searchMenu())
    expect(screen.getAllByRole('menuitem').map(item => item.textContent))
      .toEqual([en.providerDeepSeek, en.providerLegacy, 'Exa', 'perplexity (not loaded)'])
  })

  it('explains a plugin Search provider and an unselected Fetch provider', () => {
    renderPage(plugins())
    expect(searchMenu().textContent).toBe('Exa')
    expect(fetchMenu().textContent).toBe(en.providerAuto)
    expect(screen.getByText(en.pluginProviderHint)).toBeTruthy()
  })

  it('offers automatic selection where the deployment composes no provider', () => {
    const base = shipped()
    const { actions } = renderPage({
      ...base,
      search: { ...base.search, auto: true },
      fetch: { ...base.fetch, selected: '', kind: 'none', auto: true },
    })
    expect(fetchMenu().textContent).toBe(en.providerAuto)
    fireEvent.click(searchMenu())
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([en.providerAuto, en.providerDeepSeek, en.providerLegacy])
    fireEvent.click(screen.getByRole('menuitem', { name: en.providerAuto }))
    expect(actions.selectProvider).toHaveBeenCalledWith('searchProvider', '')
    fireEvent.click(fetchMenu())
    fireEvent.click(screen.getByRole('menuitem', { name: en.providerAuto }))
    expect(actions.selectProvider).toHaveBeenCalledTimes(1)
  })

  it('reports a failed provider list read in each section and retries it', () => {
    const { actions } = renderPage({ ...shipped(), providersFailed: true })
    for (const name of [en.searchSection, en.fetchSection]) {
      expect(region(name).getByRole('status').textContent).toBe(`${en.providersFailed}${en.retry}`)
      fireEvent.click(region(name).getByRole('button', { name: en.retry }))
    }
    expect(zh.providersFailed).toBe('无法读取提供方列表，此菜单可能不完整')
    expect(actions.retryProviders).toHaveBeenCalledTimes(2)
    expect(searchMenu().textContent).toBe(en.providerDeepSeek)
  })

  it('shows no provider list notice while the list read succeeds', () => {
    renderPage()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('button', { name: en.retry })).toBeNull()
  })

  it('keeps the legacy key control usable while the settings document is read-only', () => {
    const { actions } = renderPage({ ...legacy(), writable: false })
    const key = screen.getByLabelText(en.credential)
    expect(key).toHaveProperty('disabled', false)
    expect(screen.getByLabelText(en.baseUrl)).toHaveProperty('disabled', true)
    expect(searchMenu()).toHaveProperty('disabled', true)
    fireEvent.change(key, { target: { value: 'ds-secret' } })
    expect(actions.edit).toHaveBeenCalledWith('legacyApiKey', 'ds-secret')
  })

  it('disables the legacy key control when the reference itself is not writable', () => {
    renderPage(legacy({ configured: true, writable: false }))
    expect(screen.getByLabelText(en.credential)).toHaveProperty('disabled', true)
    expect(screen.getByText(en.apiKeySet)).toBeTruthy()
    expect(searchMenu()).toHaveProperty('disabled', false)
  })

  it('disables the legacy key control while a save is in flight', () => {
    const { store } = renderPage(legacy())
    expect(screen.getByLabelText(en.credential)).toHaveProperty('disabled', false)
    act(() => { store.set({ ...legacy(), saving: true }) })
    expect(screen.getByLabelText(en.credential)).toHaveProperty('disabled', true)
  })

  it.each([{ invalid: true }, { failed: true }])('locks every menu while an error must stay visible: %j', (state) => {
    renderPage({ ...apis(), ...state, selectionBlocked: true })
    expect(searchMenu()).toHaveProperty('disabled', true)
    expect(fetchMenu()).toHaveProperty('disabled', true)
    fireEvent.click(searchMenu())
    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(searchMenu().getAttribute('aria-expanded')).toBe('false')
  })

  it('closes an open menu and reports it collapsed when the menus lock', () => {
    const { store } = renderPage()
    fireEvent.click(searchMenu())
    expect(screen.getAllByRole('menuitem')).toHaveLength(2)
    act(() => { store.set({ ...shipped(), invalid: true, selectionBlocked: true }) })
    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(searchMenu().getAttribute('aria-expanded')).toBe('false')
  })

  it('explains the supported result count and blocks saving an invalid draft', () => {
    renderPage({
      ...apis(), count: field('51', { invalid: true }), invalid: true, dirty: true, selectionBlocked: true,
    })
    expect(screen.getByText(en.invalidCount)).toBeTruthy()
    expect(screen.getByLabelText(en.count).getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
  })
})
