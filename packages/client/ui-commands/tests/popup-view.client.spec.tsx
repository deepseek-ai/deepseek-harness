// @vitest-environment jsdom
/**
 * PopupSelectView interaction spec: the search input takes
 * focus on open and plain typing filters locally, ↑↓ move the filtered
 * highlight while ←→ stay native to the input, Enter and Tab select
 * single-flight, Escape and Shift+Tab dismiss back through focusComposer,
 * outside pointerdown dismisses
 * plainly, the submitting/failed states render pending text and a working
 * retry button, the highlighted row scrolls into view, and the card height
 * clamps to the space above the composer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SelectOption } from '../src/client/contract.ts'
import type { PopupSpec, TokenSegment } from '../src/client/popup.ts'
import { PopupSelectController } from '../src/client/popup.ts'
import { PopupSelectView } from '../src/client/PopupSelectView.tsx'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locales.ts'

// The framework-injected t seat, stubbed over the zh dictionaries (the default locale).
const t: Parameters<typeof PopupSelectView>[0]['t'] = makeTranslate(zh, commonZh)

// jsdom has no scrollIntoView; the view calls it on the highlighted row.
const scrollIntoView = vi.fn()
beforeEach(() => {
  Element.prototype.scrollIntoView = scrollIntoView
  scrollIntoView.mockClear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const OPTIONS: SelectOption[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light', active: true },
  { id: 'sepia', label: 'Sepia', detail: 'warm' },
]
const GATED: SelectOption = {
  id: 'full',
  label: 'Full access',
  confirmation: {
    title: 'Enable Full access?',
    description: 'Sensitive operations.',
    acknowledgeLabel: 'I understand the risks',
    cancelLabel: 'Cancel',
    confirmLabel: 'Enable Full access',
  },
}

const SEGMENT: TokenSegment = { via: 'enter', token: '/theme' }

function spec(overrides: Partial<PopupSpec<string>> = {}): PopupSpec<string> {
  return {
    options: () => Promise.resolve(OPTIONS),
    onSelect: () => undefined,
    ...overrides,
  }
}

async function mountOpen(overrides: Partial<PopupSpec<string>> = {}, consumeResult = true) {
  const consume = vi.fn((_segment: TokenSegment) => consumeResult)
  const focusComposer = vi.fn()
  const popup = new PopupSelectController<string>({ consume, focusComposer })
  const view = render(<PopupSelectView popup={popup} t={t} />)
  await act(async () => {
    popup.open('theme', spec(overrides), 'ctx-A', SEGMENT)
    await Promise.resolve()
  })
  return { popup, view, consume, focusComposer, search: screen.getByRole('textbox', { name: '筛选选项' }) }
}

function rowLabels(): string[] {
  return screen.getAllByRole('option').map(o => o.querySelector('span')!.textContent)
}

describe('PopupSelectView', () => {
  it('renders null while closed, opens with focus in the search input', async () => {
    const popup = new PopupSelectController<string>({ consume: () => true, focusComposer: () => {} })
    const view = render(<PopupSelectView popup={popup} t={t} />)
    expect(view.container.childElementCount).toBe(0)
    await act(async () => {
      popup.open('theme', spec(), 'ctx-A', SEGMENT)
      await Promise.resolve()
    })
    const search = screen.getByRole('textbox', { name: '筛选选项' })
    expect(document.activeElement).toBe(search)
    expect(rowLabels()).toEqual(['Dark', 'Light', 'Sepia'])
  })

  it('renders an optional option badge as a superscript marker', async () => {
    await mountOpen({
      options: () => Promise.resolve([{ id: 'auto', label: 'Auto review', badge: 'EXP' }]),
    })
    const row = screen.getByRole('option', { name: 'Auto review EXP' })
    expect(row.querySelector('sup')?.textContent).toBe('EXP')
  })

  it('typing filters rows locally and rebases the highlight', async () => {
    const options = vi.fn(() => Promise.resolve(OPTIONS))
    const { search } = await mountOpen({ options })
    act(() => { fireEvent.change(search, { target: { value: 'li' } }) })
    expect(rowLabels()).toEqual(['Light'])
    expect(screen.getByRole('option').getAttribute('aria-selected')).toBe('true')
    expect(options).toHaveBeenCalledTimes(1)
    act(() => { fireEvent.change(search, { target: { value: 'zzz' } }) })
    expect(screen.queryByRole('option')).toBeNull()
    expect(screen.queryByText('无选项')).not.toBeNull()
  })

  it('ArrowUp/Down move the filtered highlight; ArrowLeft/Right are left to the native caret', async () => {
    const { search } = await mountOpen()
    // Open parks the highlight on the current-value row (Light, index 1).
    expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true')
    act(() => { fireEvent.keyDown(search, { key: 'ArrowDown' }) })
    let options = screen.getAllByRole('option')
    expect(options[2]!.getAttribute('aria-selected')).toBe('true')
    act(() => { fireEvent.keyDown(search, { key: 'ArrowUp' }) })
    options = screen.getAllByRole('option')
    expect(options[1]!.getAttribute('aria-selected')).toBe('true')
    // fireEvent returns false when preventDefault was called: arrow left/right must NOT be intercepted.
    expect(fireEvent.keyDown(search, { key: 'ArrowLeft' })).toBe(true)
    expect(fireEvent.keyDown(search, { key: 'ArrowRight' })).toBe(true)
  })

  it('Tab accepts the highlighted row like Enter; Shift+Tab dismisses like Escape', async () => {
    const onSelect = vi.fn()
    const leaving = await mountOpen({ onSelect })
    // false = preventDefault ran: the shell holds focus, so Tab may not fall through.
    // Shift+Tab leaves without settling: no pick, focus back to the composer.
    expect(fireEvent.keyDown(leaving.search, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(onSelect).not.toHaveBeenCalled()
    expect(leaving.focusComposer).toHaveBeenCalledTimes(1)
    expect(leaving.view.container.childElementCount).toBe(0)
    cleanup()

    const settling = await mountOpen({ onSelect })
    // Tab settles the parked highlight — the current value — exactly like Enter.
    await act(async () => { fireEvent.keyDown(settling.search, { key: 'Tab' }) })
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(OPTIONS[1], 'ctx-A')
    expect(settling.consume).toHaveBeenCalledExactlyOnceWith(SEGMENT)
    expect(settling.focusComposer).toHaveBeenCalledTimes(1)
    expect(settling.view.container.childElementCount).toBe(0)
  })

  it('Tab stays the browser\'s while the rows are still loading: no pick, no escape', async () => {
    const popup = new PopupSelectController<string>({ consume: () => true, focusComposer: () => {} })
    render(<PopupSelectView popup={popup} t={t} />)
    await act(async () => { popup.open('theme', spec({ options: () => new Promise(() => {}) }), 'ctx-A', SEGMENT) })
    const search = screen.getByRole('textbox', { name: '筛选选项' })
    // Nothing is settleable yet, so the keystroke is not swallowed.
    expect(fireEvent.keyDown(search, { key: 'Tab' })).toBe(true)
    expect(document.activeElement).toBe(search)
    expect(screen.getByText('正在加载选项…')).toBeTruthy()
  })

  it('Tab stays the browser\'s on a failed load, so the retry stays reachable', async () => {
    const popup = new PopupSelectController<string>({ consume: () => true, focusComposer: () => {} })
    render(<PopupSelectView popup={popup} t={t} />)
    await act(async () => {
      popup.open('theme', spec({ options: () => Promise.reject(new Error('directory down')) }), 'ctx-A', SEGMENT)
      await Promise.resolve()
    })
    const search = screen.getByRole('textbox', { name: '筛选选项' })
    expect(fireEvent.keyDown(search, { key: 'Tab' })).toBe(true)
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
  })

  it('scrolls the highlighted row into view when the highlight moves', async () => {
    const { search } = await mountOpen()
    scrollIntoView.mockClear()
    act(() => { fireEvent.keyDown(search, { key: 'ArrowDown' }) })
    const options = screen.getAllByRole('option')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(scrollIntoView.mock.instances.at(-1)).toBe(options[2])
  })

  it('caps the card height at the design maximum when the composer sits low enough', async () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ bottom: 800 } as DOMRect)
    await mountOpen()
    expect(screen.getByLabelText('/theme 选项').style.maxHeight).toBe('320px')
  })

  it('clamps the card height to the space above the composer minus the safe margin', async () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ bottom: 200 } as DOMRect)
    await mountOpen()
    expect(screen.getByLabelText('/theme 选项').style.maxHeight).toBe('188px')
  })

  it('Enter accepts the parked highlight — the current value on open — then consumes, closes, and refocuses', async () => {
    const seen: Array<{ option: SelectOption; context: string }> = []
    const { view, search, consume, focusComposer } = await mountOpen({
      onSelect: (option, context) => { seen.push({ option, context }) },
    })
    await act(async () => { fireEvent.keyDown(search, { key: 'Enter' }) })
    expect(seen).toEqual([{ option: OPTIONS[1], context: 'ctx-A' }])
    expect(consume).toHaveBeenCalledExactlyOnceWith(SEGMENT)
    expect(focusComposer).toHaveBeenCalledTimes(1)
    expect(view.container.childElementCount).toBe(0)
  })

  it('click selects a row; mouseenter moves the highlight', async () => {
    const seen: SelectOption[] = []
    const { view } = await mountOpen({ onSelect: (option) => { seen.push(option) } })
    const options = screen.getAllByRole('option')
    act(() => { fireEvent.mouseEnter(options[2]!) })
    expect(screen.getAllByRole('option')[2]!.getAttribute('aria-selected')).toBe('true')
    await act(async () => { fireEvent.click(options[2]!) })
    expect(seen).toEqual([OPTIONS[2]])
    expect(view.container.childElementCount).toBe(0)
  })

  it('renders a gated option as an in-page modal and requires the checkbox before onSelect', async () => {
    const onSelect = vi.fn()
    const { popup, consume } = await mountOpen({
      options: () => Promise.resolve([GATED]),
      onSelect,
    })
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: 'Full access' })) })
    expect(screen.queryByLabelText('/theme 选项')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Enable Full access?' })).toBeTruthy()
    const enable = screen.getByRole('button', { name: 'Enable Full access' }) as HTMLButtonElement
    expect(enable.disabled).toBe(true)
    expect(onSelect).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('checkbox', { name: 'I understand the risks' }))
    expect(enable.disabled).toBe(false)
    await act(async () => { fireEvent.click(enable) })
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(GATED, 'ctx-A')
    expect(consume).toHaveBeenCalledExactlyOnceWith(SEGMENT)
    expect(popup.state.getSnapshot().open).toBe(false)
  })

  it('canceling a gated option returns to the picker with acknowledgement reset', async () => {
    await mountOpen({ options: () => Promise.resolve([GATED]) })
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: 'Full access' })) })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByLabelText('/theme 选项')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: 'Full access' })) })
    expect(screen.getByRole<HTMLInputElement>('checkbox').checked).toBe(false)
  })

  it('submitting shows pending, locks the search input, and further Enter/click no-op', async () => {
    let release!: () => void
    const onSelect = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const { search, consume } = await mountOpen({ onSelect })
    await act(async () => { fireEvent.keyDown(search, { key: 'Enter' }) })
    expect(screen.queryByText('正在应用…')).not.toBeNull()
    expect((search as HTMLInputElement).readOnly).toBe(true)
    await act(async () => {
      fireEvent.keyDown(search, { key: 'Enter' })
      fireEvent.click(screen.getAllByRole('option')[1]!)
    })
    expect(onSelect).toHaveBeenCalledTimes(1)
    await act(async () => {
      release()
      await Promise.resolve()
    })
    expect(consume).toHaveBeenCalledTimes(1)
  })

  it('a failed options load shows the error with a retry button that reloads', async () => {
    let attempts = 0
    await mountOpen({
      options: () => {
        attempts += 1
        return attempts === 1 ? Promise.reject(new Error('directory down')) : Promise.resolve(OPTIONS)
      },
    })
    expect(screen.getByRole('alert').textContent).toContain('directory down')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重试' }))
      await Promise.resolve()
    })
    expect(attempts).toBe(2)
    expect(rowLabels()).toEqual(['Dark', 'Light', 'Sepia'])
  })

  it('an onSelect failure keeps the shell open with the error strip and no retry button (re-select is the retry)', async () => {
    const { search, consume } = await mountOpen({ onSelect: () => Promise.reject(new Error('host rejected')) })
    await act(async () => { fireEvent.keyDown(search, { key: 'Enter' }) })
    expect(screen.getByRole('alert').textContent).toContain('host rejected')
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
    expect(consume).not.toHaveBeenCalled()
    expect(screen.getAllByRole('option').length).toBe(3)
  })

  it('Escape dismisses and restores composer focus', async () => {
    const { view, search, focusComposer } = await mountOpen()
    act(() => { fireEvent.keyDown(search, { key: 'Escape' }) })
    expect(view.container.childElementCount).toBe(0)
    expect(focusComposer).toHaveBeenCalledTimes(1)
  })

  it('an outside pointerdown dismisses without focusComposer; an inside one does not dismiss', async () => {
    const { view, focusComposer } = await mountOpen()
    act(() => { fireEvent.pointerDown(screen.getAllByRole('option')[0]!) })
    expect(view.container.childElementCount).not.toBe(0)
    act(() => { fireEvent.pointerDown(document.body) })
    expect(view.container.childElementCount).toBe(0)
    expect(focusComposer).not.toHaveBeenCalled()
  })
})
