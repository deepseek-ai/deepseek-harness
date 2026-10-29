// @vitest-environment jsdom
/**
 * The viewer's read-only seats: the Session's model and reasoning effort, and the share's tier.
 *
 * A viewer page states facts about the Session the owner shared. Each seat is a label with visible
 * copy, no control a reader can operate, and no request behind a click; the same components render
 * the selectable form when their `readOnly` switch is off, which is the wiring point for a future
 * grant.
 */

import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ViewerModelSeat } from '../src/client/viewer-model.tsx'
import { ViewerPermissionSeat } from '../src/client/viewer-permission.tsx'
import { ViewerSeat } from '../src/client/viewer-seat.tsx'
import { viewerCapabilities } from '../src/client/viewer-capabilities.ts'
import { en, NS, zh } from '../src/client/locales.ts'

// The seats read their copy through the locale seat the served page's client tree provides.
const locale = new LocaleRuntime(new Context())
locale.register(NS, { zh, en })
locale.setLocale('zh')
const t = locale.bind(NS)

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  viewerCapabilities.set({ mode: 'view' })
})

/** One observable store in the shape the seats read. */
function observed<T>(initial: T) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (next: T) => { snapshot = next; for (const listener of listeners) listener() },
  }
}

/** The catalog one Host serves: a named route with two effort levels and a default. */
const catalog = {
  default: { provider: 'internal', model: 'dsv41f' },
  groups: [{
    id: 'internal',
    models: [{
      id: 'dsv41f',
      name: '内网 DSV41F',
      reasoning: {
        efforts: [{ id: 'low', name: '低强度' }, { id: 'high', name: '高强度' }],
        defaultEffort: 'low',
      },
    }],
  }],
}

describe('viewer model seat', () => {
  it('states the model and the effort, with no control and no request', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    render(
      <ViewerModelSeat t={t}
        locked
        selection={observed({ lastUsed: null, next: { provider: 'internal', model: 'dsv41f', reasoningEffort: 'high' } })}
        catalog={() => Promise.resolve(catalog)}
      />,
    )

    const seat = await screen.findByText(/内网 DSV41F/)
    expect(seat.textContent).toBe('内网 DSV41F · 高强度')
    // The restriction is visible copy, not only the tooltip.
    expect(document.body.textContent).toContain(zh['viewer.model.locked'])
    const element = document.querySelector('[data-liveshare-viewer-seat="model"]')
    expect(element?.tagName).toBe('SPAN')
    expect(element?.getAttribute('aria-disabled')).toBe('true')
    expect(element?.querySelector('button, select, input, [role="button"], [role="combobox"], [tabindex]')).toBeNull()
    fireEvent.click(element as HTMLElement)
    // Nothing in this seat reaches the Host: no selection call, no fetch at all.
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('states the provider default effort for a Session that chose none', async () => {
    render(
      <ViewerModelSeat t={t}
        locked
        selection={observed({ lastUsed: null, next: { provider: 'internal', model: 'dsv41f' } })}
        catalog={() => Promise.resolve(catalog)}
      />,
    )

    expect((await screen.findByText(/内网 DSV41F/)).textContent).toBe('内网 DSV41F · 低强度')
  })

  it('states the raw effort id when the catalog names no level, and no effort when nothing states one', async () => {
    const { unmount } = render(
      <ViewerModelSeat t={t}
        locked
        selection={observed({ lastUsed: null, next: { provider: 'internal', model: 'dsv41f', reasoningEffort: 'future' } })}
        catalog={() => Promise.resolve(catalog)}
      />,
    )
    expect((await screen.findByText(/内网 DSV41F/)).textContent).toBe('内网 DSV41F · future')
    unmount()

    render(
      <ViewerModelSeat t={t}
        locked
        selection={observed({ lastUsed: null, next: { provider: 'internal', model: 'unknown-route' } })}
        catalog={() => Promise.resolve(catalog)}
      />,
    )
    // No effort is invented for a route the catalog does not describe.
    expect((await screen.findByText('unknown-route')).textContent).toBe('unknown-route')
  })

  it('states a model whose catalog entry carries no reasoning metadata by its display name alone', async () => {
    render(
      <ViewerModelSeat t={t}
        locked
        selection={observed({ lastUsed: null, next: { provider: 'internal', model: 'plain' } })}
        catalog={() => Promise.resolve({
          default: { provider: 'internal', model: 'plain' },
          groups: [{ id: 'internal', models: [{ id: 'plain', name: 'Plain model' }] }],
        })}
      />,
    )

    expect((await screen.findByText('Plain model')).textContent).toBe('Plain model')
  })

  it('states the Session’s own route when the catalog read fails outright', async () => {
    render(
      <ViewerModelSeat t={t}
        locked
        selection={observed({ lastUsed: null, next: { provider: 'internal', model: 'dsv41f', reasoningEffort: 'high' } })}
        catalog={() => Promise.reject(new Error('catalog unavailable'))}
      />,
    )

    // A failed read is not a reason to hide the Session's model: the route it states stays stated.
    expect((await screen.findByText(/dsv41f/)).textContent).toBe('dsv41f · high')
  })

  it('states no model while neither the Session nor the Host catalog names one', async () => {
    const { container } = render(
      <ViewerModelSeat t={t} locked selection={undefined} catalog={() => Promise.resolve(undefined)} />,
    )

    // The effect settles with no catalog, and a Session that states no model leaves the seat empty.
    await waitFor(() => { expect(container.querySelector('[data-liveshare-viewer-seat="model"]')).toBeNull() })
    expect(container.textContent).toBe('')
  })
})

describe('viewer permission seat', () => {
  it('states the share\u2019s own tier, with no control and no request', () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    viewerCapabilities.set({ mode: 'write' })
    render(<ViewerPermissionSeat t={t} locked capabilities={viewerCapabilities} />)

    const element = document.querySelector('[data-liveshare-viewer-seat="permission"]')
    expect(element?.textContent).toContain(zh['dialog.sessionMode.write'])
    expect(element?.textContent).toContain(zh['viewer.permission.locked'])
    expect(element?.tagName).toBe('SPAN')
    expect(element?.getAttribute('aria-disabled')).toBe('true')
    expect(element?.querySelector('button, select, input, [role="button"], [role="combobox"], [tabindex]')).toBeNull()
    fireEvent.click(element as HTMLElement)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('states an unconfirmed share as unconfirmed rather than as the narrowest tier', () => {
    viewerCapabilities.set({ mode: 'view', unconfirmed: true })
    render(<ViewerPermissionSeat t={t} locked capabilities={viewerCapabilities} />)

    const element = document.querySelector('[data-liveshare-viewer-seat="permission"]')
    expect(element?.textContent).toContain(zh['viewer.permission.unconfirmed'])
    expect(element?.textContent).not.toContain(zh['dialog.sessionMode.view'])
  })
})

describe('viewer seat switch', () => {
  it('renders the same statement as a control once the seat is selectable', () => {
    const select = vi.fn()
    render(
      <ViewerSeat
        kind="permission"
        value="Writable"
        title="The session permission this share carries"
        note="Viewers cannot change this themselves"
        readOnly={false}
        select={select}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Writable/ }))
    expect(select).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-liveshare-viewer-seat="permission"]')?.tagName).toBe('BUTTON')
  })
})
