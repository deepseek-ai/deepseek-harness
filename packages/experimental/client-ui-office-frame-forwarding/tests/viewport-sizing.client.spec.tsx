// @vitest-environment jsdom
/** Real Office fit and FF mounting with zoom-dependent scrollbar measurements. */
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { Profiler } from 'react'
import type { Props } from '../src/client/View.tsx'
import { officeViewFixture } from './helpers/office-view.client.tsx'
import { en } from '../src/client/locales.ts'

const { commits } = vi.hoisted(() => ({ commits: vi.fn() }))
// Instrument commits without replacing the production View or its children.
vi.mock('../src/client/View.tsx', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/client/View.tsx')>()
  return { ...original, OfficeView: (props: Props) => <Profiler id="office" onRender={commits}><original.OfficeView {...props} /></Profiler> }
})

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

test.each([
  ['presentation', true], ['presentation', false], ['text', true], ['text', false],
] as const)('%s fit converges across scrollbar oscillation, a height drop and restoration (docked=%s)', async (kind, docked) => {
  await using f = officeViewFixture(kind, docked)
  await f.flush()
  const scroll = f.area(), content = scroll.firstElementChild as HTMLElement
  scroll.dataset.height = '700'
  let oscillating = false, reads = 0
  // At an exact fit, subpixel overflow brings both classic scrollbars in; the
  // smaller client area then fits without them. The outer box never changes.
  const scrollbar = () => oscillating && (kind === 'presentation'
    ? Number.parseFloat(content.style.height) + 32 >= Number(scroll.dataset.height) - 0.01
    : Number.parseFloat(content.style.width) >= Number(scroll.dataset.width ?? 800) - 0.01) ? 15 : 0
  Object.defineProperties(scroll, {
    clientWidth: { configurable: true, get: () => { reads++; return Number(scroll.dataset.width ?? 800) - scrollbar() } },
    clientHeight: { configurable: true, get: () => Number(scroll.dataset.height) - scrollbar() },
  })
  await act(async () => { f.env.resize() }); await f.flush()
  const initialZoom = screen.getByRole('button', { name: en.zoom }).textContent
  oscillating = true
  commits.mockClear()
  scroll.dataset.height = '360' // Window 900 → 560 with 200px of fixed surrounding chrome.
  const settled: string[] = []
  for (let i = 0; i < 8; i++) {
    reads = 0
    await act(async () => { f.env.resize() }); await f.flush()
    expect(reads).toBeLessThan(40)
    settled.push(content.style.width)
  }
  expect(commits.mock.calls.length).toBeLessThan(10)
  expect(new Set(settled.slice(-4)).size).toBe(1)
  expect(f.area()).toBe(scroll)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(f.view.baseElement.querySelector('[data-office-surface]')?.getAttribute('data-dsh-frame-mount')).toBe('video')
  if (kind === 'presentation') {
    expect(Number.parseFloat(content.style.height)).toBeCloseTo(313)
    expect(screen.getByRole('tab', { name: 'First' }).getAttribute('aria-selected')).toBe('true')
  } else expect(Number.parseFloat(content.style.width)).toBeCloseTo(785)
  const smallerFit = Number.parseFloat(content.style.width)
  commits.mockClear()
  await act(async () => { f.env.resize() }); await f.flush()
  expect(commits).not.toHaveBeenCalled()
  oscillating = false
  scroll.dataset.height = '700'
  await act(async () => { f.env.resize() }); await f.flush()
  expect(screen.getByRole('button', { name: en.zoom }).textContent).toBe(initialZoom)
  expect(Number.parseFloat(content.style.width)).toBeGreaterThan(smallerFit)
  expect(f.area()).toBe(scroll)
  expect(f.remote.open).toHaveBeenCalledOnce()
})

test('spreadsheet resize preserves manual zoom and the selected sheet', async () => {
  await using f = officeViewFixture('spreadsheet', true)
  await f.flush()
  fireEvent.click(screen.getByRole('button', { name: en.zoomIn }))
  fireEvent.click(screen.getByRole('tab', { name: 'Second' })); await f.flush()
  const scroll = f.area()
  for (const height of ['360', '700']) {
    scroll.dataset.height = height
    await act(async () => { f.env.resize() }); await f.flush()
    expect(screen.getByRole('button', { name: en.zoom }).textContent).toBe('125%')
    expect(screen.getByRole('tab', { name: 'Second' }).getAttribute('aria-selected')).toBe('true')
    expect(f.area()).toBe(scroll)
    expect(screen.queryByRole('alert')).toBeNull()
  }
  expect(f.remote.open).toHaveBeenCalledOnce()
})
