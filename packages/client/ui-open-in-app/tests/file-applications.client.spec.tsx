// @vitest-environment jsdom
/** Shared association reads retain one native request until the last control leaves. */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionWorkspacePathApplication } from '@deepseek-ai/dsh-api-session-controller/types'
import { useFileApplications } from '../src/client/file-applications.ts'

afterEach(cleanup)
const music = [{ id: 'music', name: 'Music', default: true, icon: null }]

it('shares the initial read and publishes a menu refresh to both controls', async () => {
  const query = vi.fn(async () => music)
  const first = renderHook(() => useFileApplications('/file.mp3', query, true))
  const second = renderHook(() => useFileApplications('/file.mp3', query, true))
  await act(async () => {})
  expect(query).toHaveBeenCalledOnce()
  expect(first.result.current.apps).toBe(second.result.current.apps)
  query.mockResolvedValueOnce([{ id: 'player', name: 'Player', default: true, icon: null }])
  await act(async () => { second.result.current.refresh() })
  expect(query).toHaveBeenCalledTimes(2)
  expect(first.result.current.apps[0]?.id).toBe('player')
  expect(second.result.current.apps).toBe(first.result.current.apps)
})

it('cancels only after the last consumer leaves and discards the released result', async () => {
  const pending = Promise.withResolvers<readonly SessionWorkspacePathApplication[] | null>()
  const query = vi.fn((_path: string, _signal: AbortSignal) => pending.promise)
  const first = renderHook(() => useFileApplications('/file.mp3', query, true))
  const second = renderHook(() => useFileApplications('/file.mp3', query, true))
  const signal = query.mock.calls[0]![1]
  first.unmount()
  expect(signal.aborted).toBe(false)
  second.unmount()
  expect(signal.aborted).toBe(true)
  await act(async () => { pending.resolve(music) })
  const next = renderHook(() => useFileApplications('/file.mp3', query, true))
  expect(query).toHaveBeenCalledTimes(2)
  await act(async () => {})
  expect(next.result.current.apps).toEqual(music)
})

it('keeps disabled controls out of the query and permits refresh only while retained', async () => {
  const query = vi.fn(async () => music)
  const view = renderHook(({ enabled }) => useFileApplications('/file.mp3', query, enabled), { initialProps: { enabled: false } })
  act(() => { view.result.current.refresh() })
  expect(query).not.toHaveBeenCalled()
  view.rerender({ enabled: true })
  await act(async () => {})
  expect(view.result.current.apps).toEqual(music)
  view.rerender({ enabled: false })
  act(() => { view.result.current.refresh() })
  expect(query).toHaveBeenCalledOnce()
})
