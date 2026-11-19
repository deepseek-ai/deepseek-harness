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

function renderTab(state: ConnectorsState, version: string | undefined) {
  const store = createSnapshotStore<ConnectorsState>(state)
  const actions = { ensure: vi.fn(), retry: vi.fn(), install: vi.fn(), openPackage: vi.fn() }
  const props = {
    t: translator(en), version, ...actions, useConnectors: bindSnapshotSelector(store),
  } as ConnectorsTabProps
  render(<ConnectorsTab {...props} />)
  const set = (next: ConnectorsState): void => { act(() => { store.set(next) }) }
  return { actions, set }
}

const row = (id: string): HTMLElement => document.querySelector(`[data-connector="${id}"]`) as HTMLElement

it('lists every official connector with its brand icon before its state is known, and asks for the state once mounted', () => {
  const { actions } = renderTab({ status: 'loading', connectors: {} }, '1.2.3')
  expect(actions.ensure).toHaveBeenCalledOnce()
  expect(screen.getByRole('heading', { name: en.official })).toBeTruthy()
  expect([...document.querySelectorAll('[data-connector]')].map(item => item.getAttribute('data-connector')))
    .toEqual(['feishu', 'wecom', 'tencent-meeting', 'notion', 'tencent-docs', 'linear'])
  expect(within(row('feishu')).getByText(en['feishu.title'])).toBeTruthy()
  expect(within(row('tencent-docs')).getByText(en['tencent-docs.description'])).toBeTruthy()
  const icons = [...document.querySelectorAll('[data-connector] img')].map(icon => icon.getAttribute('src'))
  expect(icons).toHaveLength(6)
  expect(new Set(icons).size).toBe(6)
  expect(screen.queryByRole('button')).toBeNull()
})

it('installs a missing connector at the running release, and shows an installed one\'s state and opens its page', () => {
  const { actions } = renderTab({ status: 'ready', connectors: {
    '@deepseek-ai/dsh-notion': 'enabled', '@deepseek-ai/dsh-tencent-docs': 'installed', '@deepseek-ai/dsh-linear': 'missing',
  } }, '1.2.3')
  fireEvent.click(within(row('linear')).getByRole('button', { name: 'Install Linear plugin' }))
  expect(actions.install).toHaveBeenCalledExactlyOnceWith({ spec: '@deepseek-ai/dsh-linear@1.2.3', title: 'Linear plugin', version: '1.2.3' })
  expect(within(row('linear')).getAllByRole('button')).toHaveLength(1)
  expect(within(row('notion')).getByText(en.enabled)).toBeTruthy()
  expect(within(row('tencent-docs')).getByText(en.installed)).toBeTruthy()
  expect(within(row('notion')).getByRole('button', { name: 'Open Notion plugin' }).textContent).toBe(en['notion.title'])
  fireEvent.click(within(row('tencent-docs')).getByRole('button', { name: 'Open Tencent Docs plugin' }))
  expect(actions.openPackage).toHaveBeenCalledExactlyOnceWith('@deepseek-ai/dsh-tencent-docs')
  expect(within(row('tencent-docs')).getAllByRole('button')).toHaveLength(1)
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
