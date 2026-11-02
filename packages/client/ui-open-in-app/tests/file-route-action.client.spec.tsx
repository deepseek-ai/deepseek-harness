// @vitest-environment jsdom
/** Authorized file routes use the same application menu and outcome reporting as previews. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { FileRouteAction } from '../src/client/FileRouteAction.tsx'
import { en } from '../src/client/locales.ts'
import type { OpenInAppOutcome } from '../src/client/outcome.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const apps = [{ id: 'music', name: 'Music', default: true, icon: null }]
const props = () => ({
  actionUrl: 'api/present.open?sessionId=s&seq=2&index=0', available: true, pending: false,
  onAction: vi.fn(async (): Promise<OpenInAppOutcome> => ({ kind: 'opened' })),
  report: vi.fn(), t: makeTranslate(en),
})

it('queries the authorized route, selects a handler, and keeps reveal last', async () => {
  const fetcher = vi.fn(async () => Response.json(apps))
  vi.stubGlobal('fetch', fetcher)
  const p = props()
  render(<FileRouteAction {...p} />)
  await act(async () => {})
  expect(fetcher).toHaveBeenCalledWith(p.actionUrl, { signal: expect.any(AbortSignal) as AbortSignal })
  fireEvent.pointerEnter(screen.getByRole('button', { name: en['open.title'].replace('{app}', 'Music') }))
  expect(await screen.findByRole('tooltip')).toHaveProperty('textContent', en['open.title'].replace('{app}', 'Music'))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['path.more'] })) })
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Music (default)', 'Show file location'])
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Music (default)' })) })
  expect(p.onAction).toHaveBeenLastCalledWith('open', 'music')
  expect(p.report).toHaveBeenLastCalledWith({ kind: 'opened' })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['open.title'].replace('{app}', 'Music') })) })
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
  expect(screen.getByRole('button', { name: en['open.title'].replace('{app}', 'Music') })).toHaveProperty('disabled', true)
})

it('reports failure and deliberate silence, and never renders a banner of its own', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(apps)))
  const failed = props()
  failed.onAction = vi.fn(async (): Promise<OpenInAppOutcome> => ({ kind: 'failed', failure: 'openError' }))
  render(<FileRouteAction {...failed} />)
  await act(async () => {})
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['open.title'].replace('{app}', 'Music') })) })
  expect(failed.report).toHaveBeenCalledWith({ kind: 'failed', failure: 'openError' })
  // The banner belongs to ui-open-in-app's frame-wide overlay entry, not to this card control.
  expect(screen.queryByRole('alert')).toBeNull()
  cleanup()

  const dropped = props()
  dropped.onAction = vi.fn(async (): Promise<OpenInAppOutcome> => ({ kind: 'skipped' }))
  render(<FileRouteAction {...dropped} />)
  await act(async () => {})
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['open.title'].replace('{app}', 'Music') })) })
  expect(dropped.report).toHaveBeenCalledWith({ kind: 'skipped' })
  expect(screen.queryByRole('alert')).toBeNull()
})
