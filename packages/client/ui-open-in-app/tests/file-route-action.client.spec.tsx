// @vitest-environment jsdom
/** Authorized file routes use the same application menu and failure feedback as previews. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { FileRouteAction } from '../src/client/FileRouteAction.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const apps = [{ id: 'music', name: 'Music', default: true, icon: null }]
const props = () => ({ actionUrl: 'api/present.open?sessionId=s&seq=2&index=0', available: true, pending: false,
  onAction: vi.fn(async () => null), t: makeTranslate(en) })

it('queries the authorized route, selects a handler, and keeps reveal last', async () => {
  const fetcher = vi.fn(async () => Response.json(apps))
  vi.stubGlobal('fetch', fetcher)
  const p = props()
  render(<FileRouteAction {...p} />)
  await act(async () => {})
  expect(fetcher).toHaveBeenCalledWith(p.actionUrl, { signal: expect.any(AbortSignal) as AbortSignal })
  fireEvent.mouseEnter(screen.getByRole('button', { name: 'Open in Music' }))
  expect(await screen.findByRole('tooltip')).toHaveProperty('textContent', 'Open in Music')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['path.more'] })) })
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Music (default)', 'Show file location'])
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Music (default)' })) })
  expect(p.onAction).toHaveBeenLastCalledWith('open', 'music')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open in Music' })) })
  expect(p.onAction).toHaveBeenLastCalledWith('open', undefined)
})

it.each(['http', 'transport', 'invalid'] as const)('keeps reveal available after a %s query failure', async (failure) => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (failure === 'transport') throw new Error('offline')
    return failure === 'http' ? new Response(null, { status: 404 }) : Response.json({ invalid: true })
  }))
  const p = props()
  render(<FileRouteAction {...p} />)
  await act(async () => {})
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['path.reveal'] })) })
  expect(p.onAction).toHaveBeenCalledWith('reveal', undefined)
})

it('does not query without a desktop and honors another pending gesture', async () => {
  const fetcher = vi.fn(async () => Response.json(apps))
  vi.stubGlobal('fetch', fetcher)
  const p = props()
  const view = render(<FileRouteAction {...p} available={false} />)
  expect(view.container.innerHTML).toBe('')
  expect(fetcher).not.toHaveBeenCalled()
  view.rerender(<FileRouteAction {...p} pending />)
  await act(async () => {})
  expect(screen.getByRole('button', { name: 'Open in Music' })).toHaveProperty('disabled', true)
})
