// @vitest-environment jsdom
/** Terminal startup, title editing and xterm's screen lifetime. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { ITheme } from '@xterm/xterm'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { TerminalViewState } from '@deepseek-ai/dsh-api-terminal-controller/client'
import type { WebTerminalId } from '@deepseek-ai/dsh-api-terminal-controller/types'
import { TerminalBody, type TerminalBodyProps } from '../src/client/terminal.tsx'
import { TerminalTitle } from '../src/client/TerminalTitle.tsx'
import { en, zh } from '../src/client/locales.ts'

const fake = vi.hoisted(() => ({
  terminals: [] as FakeTerminal[],
  dimensions: { cols: 120, rows: 40 } as { cols: number; rows: number } | undefined,
}))
class FakeTerminal {
  options: { disableStdin?: boolean; theme?: ITheme }
  textarea: HTMLTextAreaElement | undefined = document.createElement('textarea')
  input: ((data: string) => void) | undefined
  readonly disposeInput = vi.fn()
  readonly parser = { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) }
  renderFrame: (() => void) | undefined
  readonly disposeRender = vi.fn(() => { this.renderFrame = undefined })
  readonly onRender = vi.fn((listener: () => void) => {
    this.renderFrame = listener
    return { dispose: this.disposeRender }
  })
  readonly resize = vi.fn()
  readonly reset = vi.fn()
  readonly focus = vi.fn()
  readonly dispose = vi.fn()
  readonly write = vi.fn((_data: string, callback: () => void) => { callback() })
  readonly loadAddon = vi.fn()
  constructor(options: object) { this.options = options; fake.terminals.push(this) }
  open(node: HTMLElement) { node.appendChild(this.textarea!) }
  onData(input: (data: string) => void) { this.input = input; return { dispose: this.disposeInput } }
}
vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn(function (options: object) { return new FakeTerminal(options) }) }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { proposeDimensions() { return fake.dimensions } } }))

let measure: (() => void) | undefined
const disconnect = vi.fn()
let boxWidth = 800
let boxHeight = 600
beforeEach(() => {
  fake.terminals.length = 0
  fake.dimensions = { cols: 120, rows: 40 }
  boxWidth = 800
  boxHeight = 600
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => boxWidth)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => boxHeight)
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { measure = callback } observe() {} disconnect = disconnect })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); disconnect.mockClear(); measure = undefined })

const info = { id: 'terminal' as WebTerminalId, title: 'bash', shell: { path: '/bin/bash', name: 'bash', args: ['-i'] }, cwd: '/workspace', cols: 80, rows: 24, state: 'running' as const, exitCode: null }
const environment = { cwd: '/workspace', maxCols: 200, maxRows: 100, scrollback: 1000, maxInputBytes: 1000 }
const idle: TerminalViewState = { phase: 'idle', writable: false, environment }
const titleSurfaces = [
  {
    name: 'docked tab', selector: '[data-dockkit-tab]',
    wrap: (title: ReactNode) => <div role="tab" tabIndex={0} aria-selected data-dockkit-tab="tab"><span>{title}</span></div>,
  },
  {
    name: 'floating grip', selector: '[data-dockkit-float-grip]',
    wrap: (title: ReactNode) => <header data-dockkit-float-grip="pane"><div data-dockkit-float-title><span>{title}</span></div></header>,
  },
]
function mount(initial: TerminalViewState | undefined = idle, dictionary = en) {
  let state: TerminalViewState | undefined = initial
  let visible = true
  let theme: ThemeSnapshot = { preference: 'light', fontSize: 14, active: { id: 'light', colorScheme: 'light', tokens: {} }, themes: [], revision: 0 }
  const detach = vi.fn()
  const model = {
    mount: vi.fn(() => detach), refresh: vi.fn(async () => {}),
    rename: vi.fn(async () => {}), connect: vi.fn(), write: vi.fn(), resize: vi.fn(), acknowledge: vi.fn(),
  }
  const openTab = vi.fn()
  const tab = () => ({ tab: { id: 'tab', title: 'Terminal', visible, actions: { openTab } } })
  // The test supplies the owner and model hooks consumed here; the remaining slot props are framework-owned.
  const props = {
    view: () => model,
    useTerminal: (_key: string, select?: (value: TerminalViewState | undefined) => unknown) => select === undefined ? state : select(state),
    useTheme: (select: (value: ThemeSnapshot) => unknown) => select(theme),
    useTabInfo: tab, t: makeTranslate(dictionary),
  } as unknown as TerminalBodyProps
  const view = render(<TerminalBody {...props} />)
  return {
    view, props, model, detach, openTab,
    changeTheme() { theme = { ...theme, revision: theme.revision + 1 }; view.rerender(<TerminalBody {...props} />) },
    update(next: TerminalViewState | undefined, shown = visible) {
      state = next; visible = shown; view.rerender(<TerminalBody {...props} />)
    },
  }
}

it('mounts automatic startup and offers retry only when startup fails', () => {
  const h = mount({ ...idle, phase: 'loading', environment: undefined })
  expect(h.model.mount).toHaveBeenCalledOnce()
  expect(h.view.getByRole('status').textContent).toBe(en.loading)
  expect(h.view.queryByRole('combobox')).toBeNull()
  expect(h.view.queryByRole('button')).toBeNull()
  h.update({ ...idle, phase: 'failed', error: 'unavailable' })
  expect(h.view.getByRole('alert').textContent).toContain('unavailable')
  fireEvent.click(h.view.getByRole('button', { name: en.retry }))
  expect(h.model.refresh).toHaveBeenCalledOnce()
  h.update({ ...idle, phase: 'disconnected' })
  fireEvent.click(h.view.getByRole('button', { name: en.reconnect }))
  expect(h.model.refresh).toHaveBeenCalledTimes(2)
  h.update({ ...idle, phase: 'creating' })
  expect(h.view.getByRole('status').textContent).toBe(en.creating)
  h.update({ ...idle, phase: 'closing' })
  expect(h.view.queryByRole('status')).toBeNull()
  expect(h.view.queryByRole('button')).toBeNull()
  h.update(undefined)
  expect(h.view.container.childElementCount).toBe(0)
  expect(h.model.mount).toHaveBeenCalledOnce()
})

it('shows only the terminal screen while connected and detaches on unmount', () => {
  const h = mount({ ...idle, info, phase: 'connected', writable: true })
  expect(h.view.getByRole('textbox', { name: en.title })).toBeDefined()
  expect(h.view.queryByRole('status')).toBeNull()
  expect(h.view.queryByRole('button')).toBeNull()
  expect(h.view.queryByRole('combobox')).toBeNull()
  expect(h.view.queryByRole('heading')).toBeNull()
  expect(h.view.queryByText('/workspace')).toBeNull()
  expect(h.view.container.querySelector('header')).toBeNull()
  h.view.unmount()
  expect(h.detach).toHaveBeenCalledOnce()
})

it('keeps one emulator across rename and locale updates, applies snapshots and output once, and releases listeners', () => {
  const snapshot: TerminalViewState = { ...idle, info, phase: 'connected', writable: true, render: { revision: 1, frame: { type: 'snapshot', sequence: 0, info, screen: 'restored' } } }
  const h = mount(snapshot)
  const terminal = fake.terminals[0]!
  expect(terminal.reset).toHaveBeenCalledOnce()
  expect(terminal.write).toHaveBeenCalledWith('restored', expect.any(Function))
  expect(h.model.acknowledge).toHaveBeenCalledWith(1)
  expect(terminal.focus).toHaveBeenCalledOnce()
  terminal.input?.('help\t')
  expect(h.model.write).toHaveBeenCalledWith('help\t')
  h.update({ ...snapshot, render: { revision: 2, frame: { type: 'output', sequence: 1, data: 'live' } } })
  expect(terminal.write).toHaveBeenCalledWith('live', expect.any(Function))
  h.update({ ...snapshot, render: { revision: 2, frame: { type: 'output', sequence: 1, data: 'duplicate' } } })
  expect(terminal.write).toHaveBeenCalledTimes(2)
  h.update({ ...snapshot, info: { ...info, title: 'Development' } })
  h.view.rerender(<TerminalBody {...h.props} t={makeTranslate(zh)} />)
  expect(fake.terminals).toHaveLength(1)
  expect(terminal.textarea?.getAttribute('aria-label')).toBe(zh.title)
  h.view.unmount()
  expect(terminal.dispose).toHaveBeenCalledOnce()
  expect(terminal.disposeInput).toHaveBeenCalledOnce()
  expect(disconnect).toHaveBeenCalledOnce()
})

it('displays disconnect, close and exit states and offers explicit reconnection and takeover', () => {
  const h = mount({ ...idle, info, phase: 'connecting' })
  expect(h.view.getByRole('status').textContent).toBe(en.connecting)
  h.update({ ...idle, info, phase: 'connected' })
  expect(h.view.getByRole('status').textContent).toContain(en.readonly)
  expect(fake.terminals[0]!.options.disableStdin).toBe(true)
  fireEvent.click(h.view.getByRole('button', { name: en.control }))
  expect(h.model.connect).toHaveBeenCalledOnce()
  for (const phase of ['disconnected', 'failed'] as const) {
    h.update({ ...idle, info, phase })
    fireEvent.click(h.view.getByRole('button', { name: en.reconnect }))
  }
  expect(h.model.connect).toHaveBeenCalledTimes(3)
  h.update({ ...idle, info, phase: 'closing' })
  expect(h.view.queryByRole('status')).toBeNull()
  h.update({ ...idle, info, phase: 'closed' })
  expect(h.view.getByRole('status').textContent).toContain(en.closed)
  h.update({ ...idle, info: { ...info, state: 'exited', exitCode: 5 }, phase: 'connected' })
  expect(h.view.getByRole('status').textContent).toContain('Process exited (5)')
  h.update({ ...idle, info: { ...info, state: 'exited', error: 'provider stopped' }, phase: 'connected' })
  expect(h.view.getByRole('status').textContent).toContain('Process exited (—)')
  expect(h.view.getByRole('alert').textContent).toContain('provider stopped')
  h.update({ ...idle, info: { ...info, state: 'failed', error: 'provider unreachable' }, phase: 'connected' })
  expect(h.view.getByRole('status').textContent).toBe(en.unavailable)
})

it('updates screen, cursor and selection colors without replacing the terminal or clearing output', () => {
  const colors = { backgroundColor: 'rgb(255, 255, 255)', color: 'rgb(23, 25, 29)' }
  vi.spyOn(window, 'getComputedStyle').mockImplementation(() => colors as CSSStyleDeclaration)
  const h = mount({ ...idle, info, phase: 'connected', writable: true })
  const terminal = fake.terminals[0]!
  expect(terminal.options.theme).toMatchObject({
    background: colors.backgroundColor, foreground: colors.color, cursor: colors.color, selectionForeground: colors.backgroundColor,
  })
  const appliedTheme = terminal.options.theme
  h.changeTheme()
  expect(terminal.options.theme).toBe(appliedTheme)
  colors.backgroundColor = 'rgb(23, 25, 29)'
  colors.color = 'rgb(231, 233, 238)'
  h.changeTheme()
  expect(terminal.options.theme).toEqual({
    background: colors.backgroundColor, foreground: colors.color, cursor: colors.color, cursorAccent: colors.backgroundColor,
    selectionBackground: colors.color, selectionForeground: colors.backgroundColor, selectionInactiveBackground: colors.color,
  })
  expect(fake.terminals).toEqual([terminal])
  expect(terminal.reset).not.toHaveBeenCalled()
  expect(terminal.dispose).not.toHaveBeenCalled()
  expect(h.model.mount).toHaveBeenCalledOnce()
  expect(h.detach).not.toHaveBeenCalled()
})

it('reads the current theme on xterm render and releases the cursor listener on unmount', () => {
  const colors = { backgroundColor: 'rgb(255, 255, 255)', color: 'rgb(23, 25, 29)' }
  const cursor = document.createElement('span')
  cursor.className = 'xterm-cursor'
  cursor.style.backgroundColor = 'black'
  cursor.style.color = 'cyan'
  const readStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => element === cursor ? readStyle(element) : colors as CSSStyleDeclaration)
  const h = mount({ ...idle, info, phase: 'connected', writable: true })
  const terminal = fake.terminals[0]!
  const screen = terminal.textarea!.parentElement!
  screen.append(cursor)
  const appliedTheme = terminal.options.theme
  terminal.renderFrame?.()
  expect(screen.style.getPropertyValue('--terminal-cursor')).toBe('#ffffff')
  expect(screen.style.getPropertyValue('--terminal-cursor-accent')).toBe('#000000')
  expect(terminal.options.theme).toBe(appliedTheme)

  colors.backgroundColor = 'rgb(23, 25, 29)'
  colors.color = 'rgb(231, 233, 238)'
  h.changeTheme()
  terminal.renderFrame?.()
  expect(screen.style.getPropertyValue('--terminal-cursor')).toBe(colors.color)
  expect(fake.terminals).toEqual([terminal])
  h.view.unmount()
  expect(terminal.disposeRender).toHaveBeenCalledOnce()
  expect(terminal.renderFrame).toBeUndefined()
})

it('fits only visible writable terminals with measurable dimensions and clamps the provider limits', () => {
  const state: TerminalViewState = { ...idle, info, phase: 'connected', writable: true }
  const h = mount(state)
  const terminal = fake.terminals[0]!
  expect(h.model.resize).toHaveBeenCalledWith(120, 40)
  h.model.resize.mockClear()
  fake.dimensions = { cols: 500, rows: 300 }
  measure?.()
  expect(h.model.resize).toHaveBeenCalledWith(200, 100)
  h.model.resize.mockClear()
  h.update(state, false)
  measure?.()
  h.update({ ...state, writable: false }, true)
  measure?.()
  expect(h.model.resize).not.toHaveBeenCalled()
  expect(terminal.resize).toHaveBeenLastCalledWith(80, 24)
  boxWidth = 0
  h.update(state)
  measure?.()
  boxWidth = 800; boxHeight = 0
  measure?.()
  h.update({ ...state, info: { ...info, cols: 81 } })
  expect(h.model.resize).not.toHaveBeenCalled()
  boxHeight = 600
  fake.dimensions = undefined
  measure?.()
  h.update({ ...state, environment: undefined })
  fake.dimensions = { cols: 40, rows: 20 }
  measure?.()
  h.update(state)
  for (const dimensions of [{ cols: 1, rows: 20 }, { cols: 40, rows: 0 }]) { fake.dimensions = dimensions; measure?.() }
  expect(h.model.resize).not.toHaveBeenCalled()
})

it.each(titleSurfaces)('shows saved and attached terminal names in the $name', (surface) => {
  const h = mount(idle)
  const chip = () => surface.wrap(<TerminalTitle {...h.props} />)
  const title = render(chip())
  expect(title.container.textContent).toBe('Terminal')
  h.update({ ...idle, title: 'Saved terminal' })
  title.rerender(chip())
  expect(title.container.textContent).toBe('Saved terminal')
  h.update({ ...idle, info })
  title.rerender(chip())
  expect(title.container.textContent).toBe('bash')
  expect(title.container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  expect(title.container.querySelector('svg rect')).toBeNull()
})

it.each(titleSurfaces)('renames from the $name pointer target, preserving dragging and isolating editor shortcuts', (surface) => {
  const h = mount({ ...idle, title: 'Saved terminal' })
  const outer = vi.fn()
  const title = render(<div onPointerDown={outer} onClick={outer} onDoubleClick={outer} onKeyDown={outer}>
    {surface.wrap(<TerminalTitle {...h.props} />)}
  </div>)
  fireEvent.pointerDown(title.getByText('Saved terminal'))
  expect(outer).toHaveBeenCalledOnce()
  outer.mockClear()
  fireEvent.doubleClick(title.container.querySelector(surface.selector)!)
  const input = title.getByRole('textbox', { name: en.rename }) as HTMLInputElement
  expect(document.activeElement).toBe(input)
  expect(input.selectionStart).toBe(0)
  expect(input.selectionEnd).toBe('Saved terminal'.length)
  fireEvent.pointerDown(input)
  fireEvent.click(input)
  fireEvent.doubleClick(input)
  fireEvent.keyDown(input, { key: 'ArrowLeft' })
  fireEvent.change(input, { target: { value: ' Development ' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(h.model.rename).toHaveBeenCalledWith('Development')
  expect(h.model.rename).toHaveBeenCalledOnce()
  expect(title.queryByRole('textbox', { name: en.rename })).toBeNull()
  expect(outer).not.toHaveBeenCalled()
})

it.each(titleSurfaces)('handles Escape, unchanged names and IME composition while editing the $name', (surface) => {
  const h = mount({ ...idle, info })
  const title = render(surface.wrap(<TerminalTitle {...h.props} />))
  const edit = () => {
    fireEvent.doubleClick(title.container.querySelector(surface.selector)!)
    return title.getByRole('textbox', { name: en.rename })
  }
  let input = edit()
  fireEvent.change(input, { target: { value: 'Cancelled' } })
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(h.model.rename).not.toHaveBeenCalled()
  input = edit()
  fireEvent.blur(input)
  expect(h.model.rename).not.toHaveBeenCalled()
  input = edit()
  fireEvent.change(input, { target: { value: '   ' } })
  fireEvent.blur(input)
  expect(h.model.rename).not.toHaveBeenCalled()
  input = edit()
  fireEvent.change(input, { target: { value: '开发' } })
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
  expect(title.getByRole('textbox', { name: en.rename })).toBe(input)
  expect(h.model.rename).not.toHaveBeenCalled()
  fireEvent.blur(input)
  expect(h.model.rename).toHaveBeenCalledWith('开发')
})

it.each(titleSurfaces)('removes the native $name listener when its title unmounts', (surface) => {
  const h = mount({ ...idle, info })
  const outer = vi.fn()
  const seat = (shown: boolean) => <div onDoubleClick={outer}>
    {surface.wrap(shown && <TerminalTitle {...h.props} />)}
  </div>
  const title = render(seat(false))
  const chip = title.container.querySelector(surface.selector)!
  const add = vi.spyOn(chip, 'addEventListener')
  const remove = vi.spyOn(chip, 'removeEventListener')
  title.rerender(seat(true))
  const listener = add.mock.calls.find(([type]) => type === 'dblclick')?.[1]
  expect(listener).toBeTypeOf('function')
  title.rerender(seat(false))
  expect(remove).toHaveBeenCalledExactlyOnceWith('dblclick', listener)
  fireEvent.doubleClick(chip)
  expect(outer).toHaveBeenCalledOnce()
  expect(h.model.rename).not.toHaveBeenCalled()
})

it('starts a recovered screen with no local history when environment discovery is unavailable', () => {
  mount({ ...idle, info, environment: undefined })
  expect(fake.terminals[0]!.options).toHaveProperty('scrollback', 0)
})


it.each([en, zh])('translates known terminal failures while retaining unknown Host diagnostics', (dictionary) => {
  const h = mount(idle, dictionary)
  for (const issue of ['missingTerminal', 'inputFull', 'attachmentEnded', 'invalidOutput', 'terminalLimit'] as const) {
    h.update({ ...idle, phase: 'failed', issue, error: 'raw diagnostic' })
    expect(h.view.getByRole('alert').textContent).toContain(dictionary[issue])
    expect(h.view.getByRole('alert').textContent).not.toContain('raw diagnostic')
  }
  h.update({ ...idle, phase: 'failed', error: 'Host permission denied' })
  expect(h.view.getByRole('alert').textContent).toContain('Host permission denied')
})

it.each([en, zh])('offers an explicit new terminal for missing instances without retrying the lost process', (dictionary) => {
  const h = mount({ ...idle, phase: 'failed', issue: 'missingTerminal', error: 'raw Host diagnostic' }, dictionary)
  expect(h.view.getByRole('alert').textContent).toBe(dictionary.missingTerminal)
  expect(h.view.queryByRole('button', { name: dictionary.reconnect })).toBeNull()
  expect(h.view.queryByRole('button', { name: dictionary.retry })).toBeNull()
  expect(h.view.queryByRole('textbox')).toBeNull()
  fireEvent.click(h.view.getByRole('button', { name: dictionary.new }))
  expect(h.openTab).toHaveBeenCalledExactlyOnceWith('terminal', { replaceTab: true })
  expect(h.model.refresh).not.toHaveBeenCalled()
  expect(h.model.connect).not.toHaveBeenCalled()
})

it('removes a stale emulator when the Host confirms the terminal is missing', () => {
  const h = mount({ ...idle, info, phase: 'connected', writable: true })
  const terminal = fake.terminals[0]!
  h.update({ ...idle, info, phase: 'failed', issue: 'missingTerminal' })
  expect(terminal.dispose).toHaveBeenCalledOnce()
  expect(h.view.queryByRole('textbox')).toBeNull()
  expect(h.view.getByRole('button', { name: en.new })).toBeDefined()
})

it('keeps the screen on a temporary disconnect and presents reconnection without transport diagnostics', () => {
  const h = mount({ ...idle, info, phase: 'disconnected', error: 'Remote mux WebSocket closed: 1006' })
  expect(h.view.queryByRole('alert')).toBeNull()
  expect(h.view.getByRole('status').textContent).toContain(en.disconnected)
  expect(h.view.getByRole('textbox')).toBeDefined()
  expect(h.view.queryByRole('button', { name: en.new })).toBeNull()
  fireEvent.click(h.view.getByRole('button', { name: en.reconnect }))
  expect(h.model.connect).toHaveBeenCalledOnce()
  expect(h.openTab).not.toHaveBeenCalled()
})

it('offers a new terminal after process exit while preserving its final output for reading', () => {
  const h = mount({ ...idle, info: { ...info, state: 'exited', exitCode: 0 }, phase: 'failed' })
  expect(h.view.getByRole('textbox')).toBeDefined()
  expect(h.view.queryByRole('button', { name: en.reconnect })).toBeNull()
  fireEvent.click(h.view.getByRole('button', { name: en.new }))
  expect(h.openTab).toHaveBeenCalledExactlyOnceWith('terminal', { replaceTab: true })
})
