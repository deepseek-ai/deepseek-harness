// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { ConnectorsTab, type ConnectorsTabProps } from '../src/client/ConnectorsTab.tsx'
import type { ConnectorsState } from '../src/client/connectors-store.ts'
import { en, type ConnectorsLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

function translator(dictionary: Record<ConnectorsLocaleKey, string>): ConnectorsTabProps['t'] {
  return ((key: ConnectorsLocaleKey, params?: Record<string, string>): string =>
    Object.entries(params ?? {}).reduce<string>((text, [name, value]) => text.replaceAll(`{${name}}`, value), dictionary[key])) as ConnectorsTabProps['t']
}

type TabState = Pick<ConnectorsState, 'status' | 'connectors'> & Partial<ConnectorsState>

function renderTab(state: TabState, version: string | undefined) {
  const full = (next: TabState): ConnectorsState => ({ busy: [], failed: null, ...next })
  const store = createSnapshotStore<ConnectorsState>(full(state))
  const actions = { ensure: vi.fn(), retry: vi.fn(), install: vi.fn(), openPackage: vi.fn(), setEnabled: vi.fn() }
  const props = {
    t: translator(en), version, ...actions, useConnectors: bindSnapshotSelector(store),
  } as ConnectorsTabProps
  render(<ConnectorsTab {...props} />)
  const set = (next: TabState): void => { act(() => { store.set(full(next)) }) }
  return { actions, set }
}

const row = (id: string): HTMLElement => document.querySelector(`[data-connector="${id}"]`) as HTMLElement

it('lists every official connector with its brand icon before its state is known, and asks for the state once mounted', () => {
  const { actions } = renderTab({ status: 'loading', connectors: {} }, '1.2.3')
  expect(actions.ensure).toHaveBeenCalledOnce()
  expect(screen.getByRole('heading', { name: en.official })).toBeTruthy()
  expect([...document.querySelectorAll('[data-connector]')].map(item => item.getAttribute('data-connector')))
    .toEqual(['feishu', 'wecom', 'dingtalk', 'tencent-meeting', 'notion', 'tencent-docs', 'linear'])
  expect(within(row('feishu')).getByText(en['feishu.title'])).toBeTruthy()
  expect(within(row('tencent-docs')).getByText(en['tencent-docs.description'])).toBeTruthy()
  const icons = [...document.querySelectorAll('[data-connector] img')].map(icon => icon.getAttribute('src'))
  expect(icons).toHaveLength(7)
  expect(new Set(icons).size).toBe(7)
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.queryByRole('switch')).toBeNull()
})

it('installs a missing connector at the running release, and opens an installed one\'s page from its name', () => {
  const { actions } = renderTab({ status: 'ready', connectors: {
    '@deepseek-ai/dsh-notion': 'enabled', '@deepseek-ai/dsh-tencent-docs': 'installed', '@deepseek-ai/dsh-linear': 'missing',
  } }, '1.2.3')
  fireEvent.click(within(row('linear')).getByRole('button', { name: 'Install Linear' }))
  expect(actions.install).toHaveBeenCalledExactlyOnceWith({ spec: '@deepseek-ai/dsh-linear@1.2.3', title: 'Linear', version: '1.2.3' })
  expect(within(row('linear')).getAllByRole('button')).toHaveLength(1)
  expect(within(row('linear')).queryByRole('switch')).toBeNull()
  expect(within(row('notion')).getByRole('button', { name: 'Open Notion' }).textContent).toBe(en['notion.title'])
  fireEvent.click(within(row('tencent-docs')).getByRole('button', { name: 'Open Tencent Docs' }))
  expect(actions.openPackage).toHaveBeenCalledExactlyOnceWith('@deepseek-ai/dsh-tencent-docs')
  expect(within(row('tencent-docs')).getAllByRole('button')).toHaveLength(1)
})

it('shows an installed connector\'s switch on or off, switches it without opening its page, and locks it while busy', () => {
  const connectors = { '@deepseek-ai/dsh-notion': 'enabled', '@deepseek-ai/dsh-tencent-docs': 'installed' } as const
  const { actions, set } = renderTab({ status: 'ready', connectors }, '1.2.3')
  const notion = within(row('notion')).getByRole('switch', { name: en['notion.title'] })
  const tencentDocs = within(row('tencent-docs')).getByRole('switch', { name: en['tencent-docs.title'] })
  expect(notion.getAttribute('aria-checked')).toBe('true')
  expect(tencentDocs.getAttribute('aria-checked')).toBe('false')
  fireEvent.click(notion)
  fireEvent.click(tencentDocs)
  expect(actions.setEnabled.mock.calls).toEqual([['@deepseek-ai/dsh-notion', false], ['@deepseek-ai/dsh-tencent-docs', true]])
  expect(actions.openPackage).not.toHaveBeenCalled()
  set({ status: 'ready', connectors, busy: ['@deepseek-ai/dsh-notion'] })
  expect((notion as HTMLButtonElement).disabled).toBe(true)
  expect((tencentDocs as HTMLButtonElement).disabled).toBe(false)
})

it('names the connector whose switch did not take effect until the failure clears', () => {
  const connectors = { '@deepseek-ai/dsh-notion': 'installed' } as const
  const { set } = renderTab({ status: 'ready', connectors, failed: '@deepseek-ai/dsh-notion' }, '1.2.3')
  expect(screen.getByRole('alert').textContent).toBe('Couldn’t switch Notion on or off.')
  set({ status: 'ready', connectors })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('offers no Install when the build carries no version', () => {
  renderTab({ status: 'ready', connectors: { '@deepseek-ai/dsh-linear': 'missing' } }, undefined)
  expect(within(row('linear')).queryByRole('button')).toBeNull()
})

it('reports a failed read with a retry and clears it once the state arrives', () => {
  const { actions, set } = renderTab({ status: 'error', connectors: {} }, '1.2.3')
  expect(screen.getByRole('alert').textContent).toContain(en.loadFailed)
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  expect(actions.retry).toHaveBeenCalledOnce()
  set({ status: 'ready', connectors: {} })
  expect(screen.queryByRole('alert')).toBeNull()
})
