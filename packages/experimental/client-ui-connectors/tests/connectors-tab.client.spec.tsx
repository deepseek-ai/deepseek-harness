// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PluginTabInstall } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
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
  // The page's switch, reduced to a marker that records what the tab asked it for.
  const renderEnableSwitch = vi.fn((packageName: string, install?: PluginTabInstall) =>
    <span data-switch={packageName} data-install={install === undefined ? '' : JSON.stringify(install)} />)
  const actions = { ensure: vi.fn(), retry: vi.fn(), install: vi.fn(), openPackage: vi.fn(), renderEnableSwitch }
  const props = {
    t: translator(en), version, ...actions, useConnectors: bindSnapshotSelector(store),
  } as ConnectorsTabProps
  render(<ConnectorsTab {...props} />)
  const set = (next: ConnectorsState): void => { act(() => { store.set(next) }) }
  return { actions, set }
}

const row = (id: string): HTMLElement => document.querySelector(`[data-connector="${id}"]`) as HTMLElement
const switchOf = (id: string): Element | null => row(id).querySelector('[data-switch]')

it('lists every official connector with its brand icon before its state is known, and asks for the state once mounted', () => {
  const { actions } = renderTab({ status: 'loading', connectors: {} }, '1.2.3')
  expect(actions.ensure).toHaveBeenCalledOnce()
  expect(screen.getByRole('heading', { name: en.official })).toBeTruthy()
  expect(document.querySelectorAll('[data-connector]')).toHaveLength(7)
  expect(within(row('feishu')).getByText(en['feishu.title'])).toBeTruthy()
  expect(within(row('tencent-docs')).getByText(en['tencent-docs.description'])).toBeTruthy()
  const icons = [...document.querySelectorAll('[data-connector] img')].map(icon => icon.getAttribute('src'))
  expect(icons).toHaveLength(7)
  expect(new Set(icons).size).toBe(7)
  expect(within(row('feishu')).queryByRole('button')).toBeNull()
  expect(actions.renderEnableSwitch).not.toHaveBeenCalled()
})

it('shows the page switch for each connector, with the install target only for a missing one, and opens an installed one by its name', () => {
  const { actions } = renderTab({ status: 'ready', connectors: {
    '@deepseek-ai/dsh-feishu': 'missing', '@deepseek-ai/dsh-wecom': 'installed', '@deepseek-ai/dsh-notion': 'enabled',
  } }, '1.2.3')
  expect(actions.renderEnableSwitch).toHaveBeenCalledWith('@deepseek-ai/dsh-feishu', { spec: '@deepseek-ai/dsh-feishu@1.2.3', title: 'Feishu plugin', version: '1.2.3' })
  expect(actions.renderEnableSwitch).toHaveBeenCalledWith('@deepseek-ai/dsh-wecom', undefined)
  expect(switchOf('notion')?.getAttribute('data-install')).toBe('')
  expect(switchOf('dingtalk')).toBeNull()
  expect(within(row('feishu')).queryByRole('button')).toBeNull()
  fireEvent.click(within(row('wecom')).getByRole('button', { name: 'Open WeCom plugin' }))
  expect(within(row('notion')).getByRole('button', { name: 'Open Notion plugin' }).textContent).toBe(en['notion.title'])
  expect(actions.openPackage).toHaveBeenCalledExactlyOnceWith('@deepseek-ai/dsh-wecom')
  expect(actions.install).not.toHaveBeenCalled()
})

it('offers no install target when the build carries no version', () => {
  const { actions } = renderTab({ status: 'ready', connectors: { '@deepseek-ai/dsh-feishu': 'missing' } }, undefined)
  expect(actions.renderEnableSwitch).toHaveBeenCalledWith('@deepseek-ai/dsh-feishu', undefined)
})

it('reports a failed read with a retry and clears it once the state arrives', () => {
  const { actions, set } = renderTab({ status: 'error', connectors: {} }, '1.2.3')
  expect(screen.getByRole('alert').textContent).toContain(en.loadFailed)
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  expect(actions.retry).toHaveBeenCalledOnce()
  set({ status: 'ready', connectors: {} })
  expect(screen.queryByRole('alert')).toBeNull()
})
