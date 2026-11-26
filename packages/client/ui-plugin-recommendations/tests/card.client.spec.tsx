// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ActionCardId } from '@deepseek-ai/dsh-action-cards/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import { FoldedText } from '@deepseek-ai/dsh-client-ui-action-cards/src/client/Card.tsx'
import type { ActionCardFields, ActionCardResult } from '@deepseek-ai/dsh-action-cards/types'
import type { RecommendationDetails } from '@deepseek-ai/dsh-plugin-recommendations/types'
import * as plugins from '@deepseek-ai/dsh-client-ui-plugin-manager/src/client/locales.ts'
import { PluginCardBody, type CatalogDetails, type PluginCardProps } from '../src/client/Card.tsx'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'

afterEach(cleanup)
const cardId = brandString<ActionCardId>('call-plugin-1')
const ACTION = 'enable_official_plugin'
type Act = (verb: string, payload?: ActionCardFields) => Promise<ActionCardResult | undefined>
type Describe = PluginCardProps['describe']
const available: RecommendationDetails = {
  status: 'available', title: { en: 'Session search', zh: '会话搜索' }, description: { en: 'Search past conversations', zh: '检索过去的会话' }, enabled: false,
}
const proposal = { cardId, turn: 1, action: ACTION, title: '搜索旧会话', brief: '帮你找到上周讨论的方案', details: { name: 'official-search' } as ActionCardFields }
/** An installed official connector that is on, whose account the user connects on its page. */
const connector: RecommendationDetails = {
  status: 'available', title: { en: 'Feishu', zh: '飞书' }, description: { en: 'Use Feishu documents', zh: '使用飞书文档' }, enabled: true, connector: true,
}
/** An official connector the profile does not hold, with the text the Host copies from its package. */
const installable: RecommendationDetails = {
  status: 'installable', title: { en: 'Feishu', zh: '飞书' },
  description: { en: 'Use Feishu documents, messages, and other authorized features in conversations.', zh: '在对话中使用飞书文档、消息及其他已授权的功能。' },
}
const BUILDS = ['@larksuite/cli@1.0.97']

function catalog() {
  return createSnapshotStore<Readonly<Record<string, CatalogDetails>>>({})
}

function props(decision?: { phase: string; data?: ActionCardFields }, details: RecommendationDetails = available, store = catalog()) {
  return {
    proposal, decision: decision === undefined ? undefined : { cardId, action: ACTION, ...decision },
    sessionId: brandString<SessionId>('session-1'), fallback: <p>frame fallback</p>,
    summary: <><strong>{proposal.title}</strong><FoldedText text={proposal.brief} expandLabel="展开" collapseLabel="收起" /></>,
    Folded: FoldedText, act: vi.fn<Act>(async () => ({ status: 'settled', decision: { cardId, action: ACTION, phase: 'enabled' } })),
    catalog: store, describe: vi.fn<Describe>(async () => details), openDetails: vi.fn<(name: string) => void>(),
    resolveText: (text: LocalizedText) => typeof text === 'string' ? text : text.zh ?? text.en,
    t: makeTranslate(zh),
  } satisfies PluginCardProps
}

async function shown(value: PluginCardProps) {
  const view = render(<PluginCardBody {...value} />)
  await waitFor(() => { expect(value.describe).toHaveBeenCalledWith('session-1', cardId) })
  await act(async () => {})
  return view
}

/** Text a screen reader announces as the element's description. */
function description(element: HTMLElement) {
  return element.getAttribute('aria-describedby')?.split(' ').map(id => document.getElementById(id)?.textContent)
}

it('keeps every dictionary aligned', () => {
  for (const dictionary of [en, ja, es, fr, de, ru, pt]) expect(Object.keys(dictionary).sort()).toEqual(Object.keys(zh).sort())
})

it('asks for install-script permission in the words the Plugins page uses in every language', () => {
  for (const [dictionary, page, separator] of [
    [zh, plugins.zh, ''], [en, plugins.en, ' '], [ja, plugins.ja, ''], [es, plugins.es, ' '],
    [fr, plugins.fr, ' '], [de, plugins.de, ' '], [ru, plugins.ru, ' '], [pt, plugins.pt, ' '],
  ] as const) {
    expect(dictionary['builds-blocked']).toBe(
      [page.installApprovalDescription, page.installApprovalConsequence, page.installApprovalCaution].join(separator))
    expect(dictionary.approveBuilds).toBe(page.installApproveAndRetry.replace(/\.$/, ''))
  }
})

it('shows the catalog title and description as one details target with the official badge, and enables only on click', async () => {
  const value = props()
  await shown(value)
  expect(screen.getByText('推荐插件')).toBeTruthy()
  expect(screen.getByText('官方')).toBeTruthy()
  const details = screen.getByRole('button', { name: '查看详情：会话搜索' })
  expect(details.textContent).toBe('会话搜索检索过去的会话')
  // The details label names the plugin; the catalog description stays readable as its description. The model's brief is not shown.
  expect(description(details)).toEqual(['检索过去的会话'])
  expect(screen.queryByText(proposal.brief)).toBeNull()
  expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual([details.textContent, '暂不需要', '启用'])
  expect(screen.getByText('启用后可在所有会话中使用')).toBeTruthy()
  expect(value.act).not.toHaveBeenCalled()
  fireEvent.click(details)
  expect(value.openDetails).toHaveBeenCalledWith('official-search')
  fireEvent.click(screen.getByRole('button', { name: '启用' }))
  await waitFor(() => { expect(value.act).toHaveBeenCalledExactlyOnceWith('enable') })
})

it.each([
  ['dismiss', '暂不需要', '启用'],
  ['enable', '启用', '暂不需要'],
] as const)('marks only the clicked %s action as working and disables both until the request settles', async (verb, clicked, other) => {
  const value = props()
  const pending = Promise.withResolvers<ActionCardResult | undefined>()
  value.act = vi.fn<Act>(() => pending.promise)
  await shown(value)
  fireEvent.click(screen.getByRole('button', { name: clicked }))
  expect(value.act).toHaveBeenCalledWith(verb)
  expect(screen.getByRole('button', { name: '正在处理…' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: other }).hasAttribute('disabled')).toBe(true)
  await act(async () => { pending.resolve({ status: 'settled', decision: { cardId, action: ACTION, phase: 'dismissed' } }) })
  expect(screen.getByRole('button', { name: clicked }).hasAttribute('disabled')).toBe(false)
})

it.each([
  [{ phase: 'enabled' }, zh.enabled],
  [{ phase: 'enabled', data: { application: 'restart-required' } }, zh['restart-required']],
  [{ phase: 'already-enabled' }, zh['already-enabled']],
  [{ phase: 'dismissed' }, zh.dismissed],
] as const)('shows the settled %j state without actions', async (decision, copy) => {
  await shown(props(decision))
  expect(screen.getByRole('status').textContent).toBe(copy)
  expect(screen.queryByRole('button', { name: '启用' })).toBeNull()
  expect(screen.queryByRole('button', { name: '重试启用' })).toBeNull()
})

it('names no status for a phase it does not know, and offers no action', async () => {
  await shown(props({ phase: 'future-phase', data: { application: 42 } }))
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByRole('button', { name: '启用' })).toBeNull()
})

it.each([
  [{ phase: 'failed' }, zh.failed, undefined],
  [{ phase: 'failed', data: { errorCode: 'incompatible-version' } }, zh.failed, zh['version-error']],
  [{ phase: 'failed', data: { errorCode: 'operation-error' } }, zh.failed, zh['management-error']],
  [{ phase: 'unconfirmed' }, zh.unconfirmed, undefined],
] as const)('offers a retry after %j', async (decision, status, alert) => {
  const value = props(decision)
  await shown(value)
  expect(screen.getByRole('status').textContent).toBe(status)
  expect(screen.queryByRole('alert')?.textContent).toBe(alert)
  fireEvent.click(screen.getByRole('button', { name: '重试启用' }))
  await waitFor(() => { expect(value.act).toHaveBeenCalledWith('enable') })
})

it('shows a plugin already selected in Plugins as enabled without actions', async () => {
  await shown(props(undefined, { ...available, enabled: true }))
  expect(screen.getByRole('status').textContent).toBe(zh['already-enabled'])
  expect(screen.queryByRole('button', { name: '启用' })).toBeNull()
  expect(screen.queryByRole('button', { name: '暂不需要' })).toBeNull()
})

it.each([
  [{ status: 'refused', reason: 'unavailable' }, zh.unavailable],
  [{ status: 'refused', reason: 'closing' }, zh.closing],
  [undefined, zh['lookup-failed']],
  ['offline', zh['lookup-failed']],
] as const)('offers Not now and a retry of the lookup, but not Enable, after the lookup answers %j', async (answer, message) => {
  const value = props()
  value.describe = vi.fn<Describe>(async () => available).mockImplementationOnce(async () => {
    if (answer === 'offline') throw new Error('offline')
    return answer
  })
  await shown(value)
  expect(screen.getByRole('alert').textContent).toBe(message)
  const details = screen.getByRole('button', { name: '查看详情：搜索旧会话' })
  expect(description(details)).toBeUndefined()
  expect(screen.queryByRole('button', { name: '启用' })).toBeNull()
  expect(screen.getByRole('button', { name: '暂不需要' }).hasAttribute('disabled')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await waitFor(() => { expect(screen.getByRole('button', { name: '启用' }).hasAttribute('disabled')).toBe(false) })
  expect(value.describe).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '暂不需要' }))
  await waitFor(() => { expect(value.act).toHaveBeenCalledExactlyOnceWith('dismiss') })
})

it('keeps the recorded outcome of an enabled card whose plugin has left the catalog', async () => {
  await shown(props({ phase: 'enabled' }, { status: 'refused', reason: 'unavailable' }))
  expect(screen.getByRole('status').textContent).toBe(zh.enabled)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: '查看详情：搜索旧会话' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
})

it('holds the description and action lines while the first catalog lookup is pending', async () => {
  const loading = props()
  const lookup = Promise.withResolvers<RecommendationDetails | undefined>()
  loading.describe = vi.fn<Describe>(() => lookup.promise)
  const { container } = render(<PluginCardBody {...loading} />)
  const body = container.querySelector('[aria-busy="true"]')
  expect(body).not.toBeNull()
  const details = screen.getByRole('button', { name: '查看详情：搜索旧会话' })
  expect(within(details).getByText('搜索旧会话')).toBeTruthy()
  expect(description(details)).toBeUndefined()
  expect(container.querySelectorAll('button span > span')).toHaveLength(1)
  expect(screen.getByText('启用后可在所有会话中使用')).toBeTruthy()
  for (const name of ['暂不需要', '启用']) expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(true)
  await act(async () => { lookup.resolve(available) })
  expect(body!.hasAttribute('aria-busy')).toBe(false)
  expect(within(screen.getByRole('button', { name: '查看详情：会话搜索' })).getByText('检索过去的会话')).toBeTruthy()
  expect(screen.getByRole('button', { name: '启用' }).hasAttribute('disabled')).toBe(false)
  expect(loading.catalog.getSnapshot()).toEqual({ 'official-search': available })
  cleanup()
  const left = props()
  const late = Promise.withResolvers<RecommendationDetails | undefined>()
  left.describe = vi.fn<Describe>(() => late.promise)
  render(<PluginCardBody {...left} />).unmount()
  await act(async () => { late.resolve(available) })
  expect(left.catalog.getSnapshot()).toEqual({})
  const failing = props()
  const rejected = Promise.withResolvers<RecommendationDetails | undefined>()
  failing.describe = vi.fn<Describe>(() => rejected.promise)
  render(<PluginCardBody {...failing} />).unmount()
  await act(async () => { rejected.reject(new Error('late')) })
})

it('renders a remembered plugin at once on a later card while refusals and lost replies still decide its actions', async () => {
  const shared = catalog()
  await shown(props(undefined, available, shared))
  cleanup()
  const revisit = props(undefined, available, shared)
  const lookup = Promise.withResolvers<RecommendationDetails | undefined>()
  revisit.describe = vi.fn<Describe>(() => lookup.promise)
  const { container } = render(<PluginCardBody {...revisit} />)
  expect(container.querySelector('[aria-busy]')).toBeNull()
  expect(within(screen.getByRole('button', { name: '查看详情：会话搜索' })).getByText('检索过去的会话')).toBeTruthy()
  expect(screen.getByRole('button', { name: '启用' }).hasAttribute('disabled')).toBe(false)
  await act(async () => { lookup.resolve({ ...available, enabled: true }) })
  expect(screen.getByRole('status').textContent).toBe(zh['already-enabled'])
  cleanup()
  await shown(props(undefined, { status: 'refused', reason: 'unavailable' }, shared))
  expect(screen.getByRole('alert').textContent).toBe(zh.unavailable)
  expect(screen.queryByRole('button', { name: '启用' })).toBeNull()
})

it('shows only the frame fallback when the card names no plugin', () => {
  const value = { ...props(), proposal: { ...proposal, details: {} } }
  render(<PluginCardBody {...value} />)
  expect(screen.getByText('frame fallback')).toBeTruthy()
  expect(screen.queryByText('搜索旧会话')).toBeNull()
  expect(screen.queryByRole('button')).toBeNull()
  expect(value.describe).not.toHaveBeenCalled()
})

it.each([
  [undefined, zh.transport],
  [{ status: 'refused', reason: 'access-denied' }, zh['access-denied']],
  [{ status: 'refused', reason: 'read-only' }, zh.unavailable],
  [{ status: 'unconfirmed', reason: 'closing' }, zh.closing],
] as const)('explains an unsuccessful click: %j', async (result, message) => {
  const value = props()
  value.act = vi.fn<Act>(async () => result)
  await shown(value)
  fireEvent.click(screen.getByRole('button', { name: '启用' }))
  expect((await screen.findByRole('alert')).textContent).toBe(message)
})

it('treats a lost reply as unconfirmed rather than failed', async () => {
  const value = props()
  value.act = vi.fn<Act>(async () => { throw new Error('connection reset') })
  await shown(value)
  fireEvent.click(screen.getByRole('button', { name: '启用' }))
  expect((await screen.findByRole('alert')).textContent).toBe(zh.transport)
})

it('shows a connector the profile does not hold by its copied text without a details target, and installs it only on click', async () => {
  const value = props(undefined, installable)
  const pending = Promise.withResolvers<ActionCardResult | undefined>()
  value.act = vi.fn<Act>(() => pending.promise)
  const { container } = await shown(value)
  expect(screen.getByText('飞书')).toBeTruthy()
  expect(screen.getByText('在对话中使用飞书文档、消息及其他已授权的功能。')).toBeTruthy()
  expect(screen.queryByText(proposal.title)).toBeNull()
  expect(screen.queryByText(proposal.brief)).toBeNull()
  expect(container.querySelector('[aria-busy]')).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['暂不需要', '安装并启用'])
  expect(screen.getByText('启用后可在所有会话中使用')).toBeTruthy()
  expect(value.act).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '安装并启用' }))
  expect(value.act).toHaveBeenCalledExactlyOnceWith('enable')
  expect(screen.getByRole('button', { name: '正在安装…' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: '暂不需要' }).hasAttribute('disabled')).toBe(true)
  await act(async () => { pending.resolve({ status: 'settled', decision: { cardId, action: ACTION, phase: 'failed' } }) })
  expect(value.openDetails).not.toHaveBeenCalled()
})

it('lists the install scripts a failed installation reported and allows them on click', async () => {
  const value = props({ phase: 'failed', data: { errorCode: 'operation-error', pendingBuilds: BUILDS } }, installable)
  const pending = Promise.withResolvers<ActionCardResult | undefined>()
  value.act = vi.fn<Act>(() => pending.promise)
  await shown(value)
  expect(screen.getByRole('status').textContent).toBe(zh['builds-blocked'])
  expect(within(screen.getByRole('list')).getAllByRole('listitem').map(item => item.textContent)).toEqual(BUILDS)
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '允许这些脚本并重试' }))
  expect(value.act).toHaveBeenCalledExactlyOnceWith('approve')
  expect(screen.getByRole('button', { name: '正在安装…' }).hasAttribute('disabled')).toBe(true)
  await act(async () => { pending.resolve({ status: 'refused', reason: 'unavailable' }) })
  expect(screen.getByRole('alert').textContent).toBe(zh.unavailable)
})

it.each([
  [{ phase: 'failed', data: { errorCode: 'unexpected-package' } }, zh['install-failed'], undefined],
  [{ phase: 'failed', data: { errorCode: 'incompatible-version' } }, zh['install-failed'], zh['version-error']],
  [{ phase: 'unconfirmed' }, zh.unconfirmed, undefined],
] as const)('offers to install again after %j', async (decision, status, alert) => {
  const value = props(decision, installable)
  await shown(value)
  expect(screen.getByRole('status').textContent).toBe(status)
  expect(screen.queryByRole('alert')?.textContent).toBe(alert)
  expect(screen.queryByRole('list')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '安装并启用' }))
  await waitFor(() => { expect(value.act).toHaveBeenCalledExactlyOnceWith('enable') })
})

it.each([
  [{ phase: 'enabled' }, zh.enabled],
  [undefined, zh['already-enabled']],
] as const)('offers the account connection of an enabled connector beside its status after %j', async (decision, status) => {
  const value = props(decision, connector)
  await shown(value)
  const connect = screen.getByRole('button', { name: '连接账号' })
  expect(screen.getByRole('status').textContent).toBe(status)
  // The status and the action share one row.
  expect(screen.getByRole('status').parentElement).toBe(connect.closest('footer'))
  expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['飞书使用飞书文档', '连接账号'])
  fireEvent.click(connect)
  expect(value.openDetails).toHaveBeenCalledExactlyOnceWith('official-search')
  expect(value.act).not.toHaveBeenCalled()
})

it('looks the plugin up again after an action whose recorded decision stays failed', async () => {
  const value = props({ phase: 'failed', data: { errorCode: 'operation-error', pendingBuilds: BUILDS } }, installable)
  await shown(value)
  expect(screen.getByText('在对话中使用飞书文档、消息及其他已授权的功能。')).toBeTruthy()
  // The allowed scripts let the installation land, but the connector failed to start, so the decision is failed again.
  value.describe.mockResolvedValue(connector)
  value.act.mockResolvedValue({ status: 'settled', decision: { cardId, action: ACTION, phase: 'failed', data: { errorCode: 'operation-error' } } })
  fireEvent.click(screen.getByRole('button', { name: '允许这些脚本并重试' }))
  await waitFor(() => { expect(screen.getByRole('button', { name: '查看详情：飞书' })).toBeTruthy() })
  expect(value.describe).toHaveBeenCalledTimes(2)
  expect(screen.queryByText('在对话中使用飞书文档、消息及其他已授权的功能。')).toBeNull()
})

it('keeps the failure of an enabled connector whose last decision failed, without the account connection', async () => {
  await shown(props({ phase: 'failed', data: { errorCode: 'operation-error' } }, connector))
  expect(screen.getByRole('status').textContent).toBe(zh.failed)
  expect(screen.getByRole('alert').textContent).toBe(zh['management-error'])
  expect(screen.queryByRole('button', { name: '连接账号' })).toBeNull()
  expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['飞书使用飞书文档'])
})

it('offers the account connection without a status for a phase it has no copy for', async () => {
  await shown(props({ phase: 'archived' }, connector))
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['飞书使用飞书文档', '连接账号'])
})

it('keeps a dismissed card closed after its connector was enabled elsewhere', async () => {
  await shown(props({ phase: 'dismissed' }, connector))
  expect(screen.getByRole('status').textContent).toBe(zh.dismissed)
  expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['飞书使用飞书文档'])
})

it('offers Enable without the account connection for an installed connector that is off', async () => {
  await shown(props(undefined, { ...connector, enabled: false }))
  expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['飞书使用飞书文档', '暂不需要', '启用'])
})

it('lets a connector that left the profile replace its remembered catalog text', async () => {
  const shared = catalog()
  await shown(props(undefined, connector, shared))
  cleanup()
  await shown(props(undefined, installable, shared))
  expect(screen.queryByRole('button', { name: '连接账号' })).toBeNull()
  expect(screen.queryByRole('button', { name: '查看详情：飞书' })).toBeNull()
  expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['暂不需要', '安装并启用'])
  expect(screen.getByText('在对话中使用飞书文档、消息及其他已授权的功能。')).toBeTruthy()
})
