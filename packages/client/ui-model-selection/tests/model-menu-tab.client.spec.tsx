// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ComponentProps } from 'react'
import type { OwnerOf } from '@deepseek-ai/dsh-client-ui-slots'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { en } from '../src/client/locales.ts'

beforeEach(() => {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  onTestFinished(() => {
    if (descriptor === undefined) Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    else Object.defineProperty(Element.prototype, 'scrollIntoView', descriptor)
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function setup(count = 2, hasReasoning = true, providerDefault = false) {
  const select = vi.fn(async () => ({ ok: true as const, value: undefined }))
  const toggle = vi.fn()
  const directory = createSnapshotStore<ModelDirectoryState>({
    current: { provider: 'sample', model: 'model-1' }, routable: true,
    groups: [{ id: 'sample', name: 'Sample', models: Array.from({ length: count }, (_, index) => ({
      id: `model-${index + 1}`, name: `Model ${index + 1}`,
      ...hasReasoning ? { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
        ...providerDefault ? {} : { defaultEffort: 'high' } } } : {},
    })) }], failures: [], status: 'ready', pending: null, error: null,
  })
  const renderSlot: ComponentProps<typeof ModelSelect>['renderSlot'] = (name, owner: object, options) => {
    if (name === 'conversation.input.model.options') {
      const controls = owner as OwnerOf<'conversation.input.model.options'>
      return <>
        <button hidden>Hidden option</button><button disabled>Disabled option</button>
        <button role="menuitem" data-model-menu-page="team-test" disabled={controls.locked}
          aria-disabled={controls.locked || controls.pending}
          onClick={() => { if (!controls.pending) controls.openPage({ key: 'team-test', title: 'Team settings' }) }}>Agent teamwork</button>
      </>
    }
    if (name === 'conversation.input.model.page') {
      const controls = owner as OwnerOf<'conversation.input.model.page'>
      return <button role="switch" aria-checked="false" disabled={controls.locked} aria-disabled={controls.locked || controls.pending}
        onClick={() => { if (!controls.pending) toggle() }}>Enable teamwork</button>
    }
    return options?.fallback ?? null
  }
  render(<><button>Before</button><ModelSelect locked={false} available directory={directory} load={vi.fn()}
    resolveText={text => typeof text === 'string' ? text : text.en} select={select} renderSlot={renderSlot} t={makeTranslate(en)} /><button>After</button></>)
  const trigger = screen.getByRole('button', { name: /^Select model, current/ })
  fireEvent.click(trigger)
  const model = () => screen.getByRole('menuitem', { name: /Model.*Model 1/ })
  const team = () => screen.getByRole('menuitem', { name: 'Agent teamwork' })
  const tag = () => screen.getByRole('button', { name: /^Effort:/ })
  return { select, toggle, directory, trigger, model, team, tag }
}
function tab(shiftKey = false) {
  const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
  fireEvent(document.activeElement!, event)
  return event
}

it('Tab moves from the trigger through root controls without opening a page or selecting a value', () => {
  const view = setup()
  tab()
  expect(document.activeElement).toBe(view.model())
  tab()
  expect(document.activeElement).toBe(view.tag())
  tab()
  expect(document.activeElement).toBe(screen.getByRole('slider', { name: 'Effort' }))
  tab()
  expect(document.activeElement).toBe(view.team())
  tab(true)
  expect(document.activeElement).toBe(screen.getByRole('slider'))
  tab(true)
  expect(document.activeElement).toBe(view.tag())
  tab(true)
  expect(document.activeElement).toBe(view.model())
  expect(screen.queryByRole('menuitemradio')).toBeNull()
  expect(screen.queryByRole('switch')).toBeNull()
  expect(view.select).not.toHaveBeenCalled()
  expect(view.toggle).not.toHaveBeenCalled()
})

it('includes default information before the range and keeps Escape at the tooltip layer first', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const view = setup(2, true, true)
  tab()
  expect(document.activeElement).toBe(view.model())
  tab()
  expect(document.activeElement).toBe(view.tag())
  tab()
  const info = screen.getByRole('button', { name: en['effort.defaultInfoLabel'] })
  expect(document.activeElement).toBe(info)
  fireEvent.click(info)
  expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe(en['effort.defaultExplanation'])
  fireEvent.keyDown(info, { key: 'Escape' })
  expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull()
  expect(screen.getByRole('menu')).toBeTruthy()
  expect(document.activeElement).toBe(info)
  fireEvent.click(info)
  tab()
  const slider = screen.getByRole('slider')
  expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull()
  expect(document.activeElement).toBe(slider)
  tab()
  expect(document.activeElement).toBe(view.team())
  tab(true)
  expect(document.activeElement).toBe(slider)
  tab(true)
  expect(document.activeElement).toBe(info)
  expect(view.select).not.toHaveBeenCalled()
  expect(view.toggle).not.toHaveBeenCalled()
})

it('removes only the default information Tab stop when the selection changes', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const view = setup(2, true, true)
  const info = screen.getByRole('button', { name: en['effort.defaultInfoLabel'] })
  info.focus()
  act(() => { view.directory.update((snapshot) => {
    snapshot.current = { provider: 'sample', model: 'model-1', reasoningEffort: 'high' }
  }) })
  const slider = screen.getByRole('slider')
  expect(screen.queryByRole('button', { name: en['effort.defaultInfoLabel'] })).toBeNull()
  expect(document.activeElement).toBe(slider)
  tab(true)
  expect(document.activeElement).toBe(view.tag())
  act(() => { view.directory.update((snapshot) => {
    snapshot.current = { provider: 'sample', model: 'model-1' }
  }) })
  tab()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: en['effort.defaultInfoLabel'] }))
  expect(view.select).not.toHaveBeenCalled()
})

it('keeps a pending contributed entry in Tab order without allowing navigation', () => {
  const view = setup()
  tab(); tab(); tab(); tab()
  const team = view.team()
  expect(document.activeElement).toBe(team)
  act(() => { view.directory.update((snapshot) => {
    snapshot.status = 'selecting'
    snapshot.pending = { provider: 'sample', model: 'model-1', reasoningEffort: 'low' }
  }) })
  expect(view.team()).toBe(team)
  expect(team.hasAttribute('disabled')).toBe(false)
  expect(team.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(team)
  fireEvent.click(team)
  expect(screen.queryByRole('switch')).toBeNull()
  tab(true)
  expect(document.activeElement).toBe(screen.getByRole('slider'))
  tab()
  expect(document.activeElement).toBe(team)
  expect(view.select).not.toHaveBeenCalled()
  expect(view.toggle).not.toHaveBeenCalled()
})

it('Shift+Tab from the first root control returns to its trigger instead of activating it', () => {
  const view = setup()
  tab()
  expect(tab(true).defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(view.trigger)
  expect(screen.queryByRole('menu')).toBeNull()
  expect(view.select).not.toHaveBeenCalled()
})

it('Tab at the final root control closes the portal and leaves native forward traversal enabled', () => {
  const view = setup()
  view.team().focus()
  expect(tab().defaultPrevented).toBe(false)
  expect(document.activeElement).toBe(view.trigger)
  expect(screen.queryByRole('menu')).toBeNull()
  expect(view.toggle).not.toHaveBeenCalled()
})

it('skips a reasoning control when the model does not advertise one', () => {
  const view = setup(2, false)
  tab(); tab()
  expect(document.activeElement).toBe(view.team())
  expect(screen.queryByRole('slider')).toBeNull()
  expect(view.select).not.toHaveBeenCalled()
})

it('Tab and Shift+Tab traverse small model lists without choosing any model', () => {
  const view = setup()
  fireEvent.click(view.model())
  const rows = screen.getAllByRole('menuitemradio')
  expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
  expect(document.activeElement).toBe(rows[0])
  tab()
  expect(document.activeElement).toBe(rows[1])
  tab(true)
  expect(document.activeElement).toBe(rows[0])
  expect(view.select).not.toHaveBeenCalled()
})

it('Tab leaves search without committing; Shift+Tab returns through search to the trigger', () => {
  const view = setup(6)
  fireEvent.click(view.model())
  const search = screen.getByRole('searchbox')
  fireEvent.keyDown(search, { key: 'ArrowDown' })
  tab()
  expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Model 2' }))
  expect(view.select).not.toHaveBeenCalled()
  expect(screen.getAllByRole('menuitemradio').filter(row => row.tabIndex === 0)).toHaveLength(1)
  tab(true)
  expect(document.activeElement).toBe(search)
  tab(true)
  expect(document.activeElement).toBe(view.trigger)
  expect(screen.queryByRole('searchbox')).toBeNull()
})

it('includes the search clear button in Tab order and keeps Space native in search', () => {
  const view = setup(6)
  fireEvent.click(view.model())
  const search = screen.getByRole('searchbox')
  fireEvent.change(search, { target: { value: 'Model 2' } })
  const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
  fireEvent(search, space)
  expect(space.defaultPrevented).toBe(false)
  tab()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Clear search' }))
  tab()
  expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Model 2' }))
  expect(view.select).not.toHaveBeenCalled()
})

it('Enter still selects a highlighted search result', async () => {
  const view = setup(6)
  fireEvent.click(view.model())
  const search = screen.getByRole('searchbox')
  fireEvent.change(search, { target: { value: 'Model 2' } })
  await act(async () => { fireEvent.keyDown(search, { key: 'Enter' }) })
  await waitFor(() => {
    expect(view.select).toHaveBeenCalledExactlyOnceWith({ provider: 'sample', model: 'model-2' })
  })
})

it.each([2, 6])('returns from %i model choices with Escape, then closes the root with Escape', async (count) => {
  const view = setup(count)
  fireEvent.click(view.model())
  expect(screen.queryByText('Model', { exact: true })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(screen.getByRole('slider')).toBeTruthy()
  expect(document.activeElement).toBe(view.model())
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  await waitFor(() => { expect(document.activeElement).toBe(view.trigger) })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(view.select).not.toHaveBeenCalled()
})

it('Tab leaves the Team page without toggling, while Escape returns to its root entry', () => {
  const view = setup()
  fireEvent.click(view.team())
  const toggle = screen.getByRole('switch')
  expect(screen.getByRole('menu', { name: 'Team settings' })).toBeTruthy()
  expect(screen.queryByText('Team settings')).toBeNull()
  expect(document.activeElement).toBe(toggle)
  expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
  tab(true)
  expect(document.activeElement).toBe(view.trigger)
  expect(screen.queryByRole('switch')).toBeNull()
  expect(view.toggle).not.toHaveBeenCalled()
  fireEvent.click(view.trigger)
  fireEvent.click(view.team())
  fireEvent.keyDown(screen.getByRole('switch'), { key: 'Escape' })
  expect(screen.queryByRole('switch')).toBeNull()
  expect(view.team()).toBe(document.activeElement)
})
