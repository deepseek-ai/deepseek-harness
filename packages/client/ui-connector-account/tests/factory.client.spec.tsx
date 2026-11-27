// @vitest-environment jsdom
/**
 * Another plugin renders one account by key through the `connector.account` Factory, which follows the page's stream,
 * starts the account's operations on the Host, and is withdrawn with the plugin.
 */
import { fireEvent, waitFor } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import type { ConnectorAccountEntry, ConnectorAccountsView, ConnectorOperationId } from '../src/types.ts'

const KEY = 'mcp:docs'
const OP = 'op-1' as ConnectorOperationId

function entry(phase: 'disconnected' | 'connected'): ConnectorAccountEntry {
  return {
    key: KEY,
    copy: { title: 'Docs account', hint: 'Authorize in a browser on this computer.', activation: { title: 'Connect docs', body: 'On.', connect: 'Connect' } },
    display: phase === 'disconnected'
      ? { phase, status: 'Not connected', buttons: [{ label: 'Connect', command: { kind: 'start', operation: 'connect' }, variant: 'primary' }], notes: [] }
      : { phase, status: 'Connected', buttons: [], notes: [] },
  }
}

async function bench() {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('en')
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  const views: ConnectorAccountsView[] = []
  let wake: (() => void) | undefined
  const closed = vi.fn()
  // The Client stream supervisor, reduced to opening its generation and delivering each item.
  Object.assign(runtime.remote, {
    $stream: (options: { open: (signal: AbortSignal) => AsyncIterable<ConnectorAccountsView> }) => {
      const generation = new AbortController()
      return {
        async *[Symbol.asyncIterator]() {
          for await (const value of options.open(generation.signal)) yield { value, accept: () => {} }
        },
        dispose: async () => { closed(); generation.abort() },
      }
    },
  })
  const start = vi.fn(async (_key: string, _operation: string): Promise<RemoteResult<ConnectorOperationId>> => ({ ok: true, value: OP }))
  runtime.remote.provideNamespaces({
    connectorAccounts: {
      async *watch(signal: AbortSignal) {
        signal.addEventListener('abort', () => { wake?.() }, { once: true })
        for (;;) {
          if (signal.aborted) return
          const next = views.shift()
          if (next !== undefined) { yield next; continue }
          await new Promise<void>((resolve) => { wake = resolve })
        }
      },
      start, cancel: vi.fn(),
    },
  })
  const feature = await runtime.mount({ inject: [...inject], apply })
  await runtime.root.declare({}, ({ renderFactorySlot }: PropsRuntime<'root'> & PropsRenderFactories) => (
    <>
      <div data-place="page">{renderFactorySlot('connector.account', { account: KEY, presentation: 'section' })}</div>
      <div data-place="row">{renderFactorySlot('connector.account', { account: KEY, presentation: 'status' })}</div>
    </>
  ))
  const page = runtime.renderRoot()
  return {
    runtime, feature, page, start, closed,
    publish(...accounts: ConnectorAccountEntry[]) { views.push({ accounts }); wake?.() },
  }
}

it('shows an account by key as its section or its status line once the Host lists it, and starts its operations', async () => {
  const b = await bench()
  expect(b.page.container.querySelector('[data-connector-account]')).toBeNull()
  b.publish(entry('disconnected'))
  await b.page.findByRole('heading', { name: 'Docs account' })
  expect(b.page.container.querySelector('[data-place="row"] [data-connector-account="disconnected"]')?.textContent).toBe('Not connected')
  fireEvent.click(b.page.getByRole('button', { name: 'Connect' }))
  await waitFor(() => { expect(b.start).toHaveBeenCalledWith(KEY, 'connect') })
  b.publish(entry('connected'))
  await waitFor(() => {
    expect(b.page.container.querySelector('[data-place="row"] [data-connector-account]')?.getAttribute('data-connector-account')).toBe('connected')
  })
})

it('withdraws the Factory and the stream with the plugin', async () => {
  const b = await bench()
  expect(b.runtime.factoryOf('connector.account')).toBeDefined()
  await b.feature.fiber.dispose()
  expect(() => b.runtime.factoryOf('connector.account')).toThrow()
  expect(b.closed).toHaveBeenCalledOnce()
})
