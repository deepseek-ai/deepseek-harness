// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { JsonTree as LocalizedJsonTree } from '@deepseek-ai/dsh-client-ui-primitives'
import { jsonTreeLabels } from './labels.client.ts'

function JsonTree(props: Omit<ComponentProps<typeof LocalizedJsonTree>, 'label' | 'labels'> & {
  label?: string
}) {
  return <LocalizedJsonTree label="JSON" {...props} labels={jsonTreeLabels} />
}

let writeText: ReturnType<typeof vi.fn<Clipboard['writeText']>>
let originalClipboard: PropertyDescriptor | undefined

beforeEach(() => {
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  writeText = vi.fn<Clipboard['writeText']>().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalClipboard === undefined) Reflect.deleteProperty(navigator, 'clipboard')
  else Object.defineProperty(navigator, 'clipboard', originalClipboard)
})

function stubStringLayout(scrollHeight = 200): void {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(scrollHeight)
  const computedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
    const style = computedStyle(element)
    style.lineHeight = '16px'
    if (style.paddingBottom === '') style.paddingBottom = '0px'
    return style
  })
}

describe('JsonTree', () => {
  it('ignores clipboard settlement after the row changes or the tree unmounts', async () => {
    vi.useFakeTimers()
    const pending: (() => void)[] = []
    writeText.mockImplementation(() => new Promise<void>((resolve) => { pending.push(resolve) }))
    const view = render(<JsonTree data={{ first: 1, second: 2 }} />)
    const rows = screen.getAllByRole('treeitem')
    fireEvent.mouseOver(rows[0] as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: 'Copy value' }))
    fireEvent.mouseOver(rows[1] as HTMLElement)
    await act(async () => { pending[0]!() })
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Copy value' }))
    view.unmount()
    const timerCount = vi.getTimerCount()
    await act(async () => { pending[1]!() })
    expect(vi.getTimerCount()).toBe(timerCount)
  })

  it('updates copy actions without rereading JSON properties on hover', () => {
    const readValue = vi.fn(() => 'payload '.repeat(100))
    const data = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [
      `field${index}`,
      { get value() { return readValue() } },
    ]))
    render(<JsonTree data={data} />)
    const rows = within(screen.getByRole('tree')).getAllByRole('treeitem')
    readValue.mockClear()

    fireEvent.mouseOver(rows[0] as HTMLElement)
    expect(within(rows[0] as HTMLElement).getByRole('button', { name: 'Copy pretty JSON' })).toBeTruthy()
    fireEvent.mouseOver(rows[1] as HTMLElement)
    expect(within(rows[0] as HTMLElement).queryByRole('button', { name: 'Copy pretty JSON' })).toBeNull()
    expect(within(rows[1] as HTMLElement).getByRole('button', { name: 'Copy pretty JSON' })).toBeTruthy()
    expect(readValue).not.toHaveBeenCalled()
  })

  it('expands raw strings without ResizeObserver and keeps the visible viewport limit', () => {
    stubStringLayout()
    vi.stubGlobal('ResizeObserver', undefined)
    let rawTop = 150
    const view = render(
      <div style={{ overflowY: 'auto', paddingBottom: '10px' }}>
        <JsonTree data={{ first: 'raw\ntext', last: 'last\ntext' }} />
      </div>,
    )
    const clip = view.container.firstElementChild as HTMLElement
    vi.spyOn(clip, 'clientTop', 'get').mockReturnValue(2)
    vi.spyOn(clip, 'clientHeight', 'get').mockReturnValue(140)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return new DOMRect(0, this === clip ? 100 : rawTop, 200, 140)
    })
    const rows = within(screen.getByRole('tree')).getAllByRole('treeitem')
    fireEvent.click(within(rows[0] as HTMLElement).getByRole('button', { name: 'Expand JSON node' }))
    const raw = rows[0]?.querySelector('pre') as HTMLPreElement
    expect(raw.textContent).toBe('raw\ntext')
    expect(raw.style.maxHeight).toBe('78px')
    expect(raw.nextElementSibling?.textContent).toBe(',')

    rawTop = 80
    fireEvent.scroll(clip)
    expect(raw.style.maxHeight).toBe('126px')
    rawTop = 300
    fireEvent.resize(window)
    expect(raw.style.maxHeight).toBe('16px')
    fireEvent.click(within(rows[0] as HTMLElement).getByRole('button', { name: 'Collapse JSON node' }))
    expect(raw.isConnected).toBe(false)
    rawTop = 100
    fireEvent.scroll(clip)
    expect(raw.style.maxHeight).toBe('16px')

    fireEvent.click(within(rows[1] as HTMLElement).getByRole('button', { name: 'Expand JSON node' }))
    expect(rows[1]?.querySelector('pre')?.nextElementSibling?.textContent).not.toBe(',')
  })

  it('shows the string expander only beyond the configured collapsed line count', () => {
    stubStringLayout(48)
    let resize: (() => void) | undefined
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback }
      observe() {}
      disconnect = disconnect
    })
    const data = { text: 'three lines of text' }
    const view = render(<JsonTree data={data} />)
    expect(screen.queryByRole('button', { name: 'Expand JSON node' })).toBeNull()
    view.rerender(<JsonTree data={data} collapsedStringLines={2} />)
    expect(screen.getByRole('button', { name: 'Expand JSON node' })).toBeTruthy()
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(16)
    act(() => { resize?.() })
    expect(screen.queryByRole('button', { name: 'Expand JSON node' })).toBeNull()
    view.unmount()
    expect(disconnect).toHaveBeenCalledTimes(2)
  })

  it('keeps raw strings intact and samples the wrapping preference on every expansion', async () => {
    stubStringLayout()
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    let wrapped = false
    const stringWrapping = {
      label: 'Wrap lines',
      getDefault: () => wrapped,
      setDefault: (value: boolean) => { wrapped = value },
    }
    const original = `  leading spaces\n\t"quoted" \\${'long'.repeat(100)}\nlast line\n`
    render(<JsonTree data={{ first: original, second: original }} stringWrapping={stringWrapping} />)
    const [first, second] = within(screen.getByRole('tree')).getAllByRole('treeitem')
    const a = within(first as HTMLElement)
    const b = within(second as HTMLElement)
    fireEvent.click(a.getByRole('button', { name: 'Expand JSON node' }))
    fireEvent.click(b.getByRole('button', { name: 'Expand JSON node' }))
    expect(a.getByRole('button', { name: 'Wrap lines' }).getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(a.getByRole('button', { name: 'Wrap lines' }))
    expect(wrapped).toBe(true)
    expect(a.getByRole('button', { name: 'Wrap lines' }).getAttribute('aria-pressed')).toBe('true')
    expect(b.getByRole('button', { name: 'Wrap lines' }).getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(b.getByRole('button', { name: 'Collapse JSON node' }))
    fireEvent.click(b.getByRole('button', { name: 'Expand JSON node' }))
    expect(b.getByRole('button', { name: 'Wrap lines' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(b.getByRole('button', { name: 'Wrap lines' }))
    expect(wrapped).toBe(false)
    expect(a.getByRole('button', { name: 'Wrap lines' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(a.getByRole('button', { name: 'Collapse JSON node' }))
    fireEvent.click(a.getByRole('button', { name: 'Expand JSON node' }))
    const toggle = a.getByRole('button', { name: 'Wrap lines' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    const contents = document.getElementById(toggle.getAttribute('aria-controls') as string)
    expect(contents?.textContent).toBe(original)
    fireEvent.click(a.getByRole('button', { name: 'Copy value' }))
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith(original) })
  })

  it('keeps the top level open and renders expandable value previews', () => {
    render(
      <JsonTree
        label="Payload"
        data={{
          nested: { answer: 42 },
          list: ['alpha', 'beta'],
        }}
      />,
    )

    const tree = screen.getByRole('tree', { name: 'Payload' })
    const rows = within(tree).getAllByRole('treeitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toBe('nested:{answer: 42},')
    expect(rows[1]?.textContent).toBe('list:["alpha", "beta"]')

    const expanders = within(tree).getAllByRole('button', { name: 'Expand JSON node' })
    expect(expanders[0]?.tabIndex).toBe(0)
    expect(expanders[1]?.tabIndex).toBe(-1)

    fireEvent.click(expanders[0] as HTMLElement)
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(3)
    expect(screen.getByText('answer:')).toBeDefined()
    expect(within(tree).getByRole('button', { name: 'Collapse JSON node' })).toBeDefined()
  })

  it('moves the single tab stop between visible expanders with arrow keys', () => {
    render(
      <JsonTree
        expandTopLevel={false}
        data={{
          first: { nested: 1 },
          second: { nested: 2 },
        }}
      />,
    )

    const tree = screen.getByRole('tree', { name: 'JSON' })
    const root = within(tree).getByRole('button', { name: 'Collapse JSON node' })
    const children = within(tree).getAllByRole('button', { name: 'Expand JSON node' })

    expect(root.tabIndex).toBe(0)
    fireEvent.keyDown(root, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(children[0])
    expect(root.tabIndex).toBe(-1)
    expect(children[0]?.tabIndex).toBe(0)

    fireEvent.keyDown(children[0] as HTMLElement, { key: 'ArrowRight' })
    expect(children[0]?.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(children[0] as HTMLElement, { key: 'ArrowLeft' })
    expect(children[0]?.getAttribute('aria-expanded')).toBe('false')
    fireEvent.keyDown(children[0] as HTMLElement, { key: 'Enter' })

    fireEvent.keyDown(children[0] as HTMLElement, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(root)
    fireEvent.keyDown(root, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(children[1])
  })

  it('copies an array element path without recovering data from rendered labels', async () => {
    render(<JsonTree data={{ list: [{ value: 'x' }, 'tail'] }} />)

    const tree = screen.getByRole('tree')
    fireEvent.click(within(tree).getByRole('button', { name: 'Expand JSON node' }))
    const arrayRow = within(tree).getAllByRole('treeitem')
      .find(row => row.textContent?.startsWith('0:'))
    expect(arrayRow).toBeDefined()

    fireEvent.mouseOver(arrayRow as HTMLElement)
    const copyButton = screen.getByRole('button', { name: 'Copy pretty JSON' })
    fireEvent.contextMenu(copyButton)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy property path' }))

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('$.list[0]')
    })
  })

  it('renders empty containers, JSON-adjacent primitives, and bounded deep previews', () => {
    const anonymous = Object.defineProperty(() => {}, 'name', { value: '' })
    const date = new Date('2026-07-28T00:00:00.000Z')
    const data = {
      '': 'empty key',
      nil: null,
      text: 'quoted',
      flag: true,
      count: 3,
      big: 4n,
      date,
      named: function named() {},
      missing: undefined,
      symbol: Symbol('token'),
      emptyObject: {},
      emptyArray: [],
      primitivePreview: {
        nil: null,
        flag: false,
        big: 9n,
        missing: undefined,
      },
      exoticPreview: {
        symbol: Symbol(),
        named: function sample() {},
        anonymous,
        date,
      },
      wideObject: { a: 1, b: 2, c: 3, d: 4, e: 5 },
      wideArray: [1, 2, 3, 4, 5, 6],
      deep: { a: { b: { c: 1 } } },
    }
    render(<JsonTree copyable={false} data={data} />)

    const text = screen.getByRole('tree').textContent
    expect(text).toContain('"":\"empty key\"')
    expect(text).toContain('nil:null')
    expect(text).toContain('flag:true')
    expect(text).toContain('count:3')
    expect(text).toContain('big:4n')
    expect(text).toContain('date:2026-07-28T00:00:00.000Z')
    expect(text).toContain('named:function() { }')
    expect(text).toContain('missing:undefined')
    expect(text).toContain('symbol:Symbol(token)')
    expect(text).toContain('emptyObject:{}')
    expect(text).toContain('emptyArray:[]')
    expect(text).toContain('primitivePreview:{nil: null, flag: false, big: 9, missing: undefined}')
    expect(text).toContain('exoticPreview:{symbol: Symbol, named: sample, anonymous: Function, date: }')
    expect(text).toContain('wideObject:{a: 1, b: 2, c: 3, d: 4, …}')
    expect(text).toContain('wideArray:[1, 2, 3, 4, 5, …]')
    expect(text).toContain('deep:{a: {b: {…}}}')
    expect(screen.queryByRole('button', { name: /Copy/ })).toBeNull()
    fireEvent.mouseOver(screen.getByRole('tree').parentElement as HTMLElement)
  })

  it('renders child commas and lets a clickable property label toggle its node', () => {
    render(<JsonTree data={{ parent: { emptyObject: {}, emptyArray: [], scalar: 1, last: 2 } }} />)

    fireEvent.click(screen.getByText('parent:'))
    const tree = screen.getByRole('tree')
    const rows = within(tree).getAllByRole('treeitem')
    expect(rows.find(row => row.textContent === 'emptyObject:{},')).toBeDefined()
    expect(rows.find(row => row.textContent === 'emptyArray:[],')).toBeDefined()
    expect(rows.find(row => row.textContent === 'scalar:1,')).toBeDefined()
    expect(rows.find(row => row.textContent === 'last:2')).toBeDefined()

    fireEvent.click(screen.getByText('parent:'))
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(1)
  })

  it('assigns the initial array tab stop and supports an empty collapsible root', () => {
    const first = render(<JsonTree data={['plain', { nested: true }]} />)
    const tree = screen.getByRole('tree')
    expect(tree.textContent).toContain('0:"plain"')
    expect(within(tree).getByRole('button', { name: 'Expand JSON node' }).tabIndex).toBe(0)
    first.unmount()

    render(<JsonTree expandTopLevel={false} data={{}} />)
    expect(screen.getByRole('tree').textContent).toBe('{}')
    expect(screen.queryByRole('button', { name: /JSON node/ })).toBeNull()
  })

  it('copies primitive and object values in every menu mode', async () => {
    const anonymous = Object.defineProperty(() => {}, 'name', { value: '' })
    render(
      <JsonTree
        data={{
          plain: 'hello',
          'odd-key': 3,
          object: { a: 1 },
          missing: undefined,
          big: 7n,
          symbol: Symbol(),
          symbolNamed: Symbol('token'),
          named: function named() {},
          anonymous,
        }}
      />,
    )

    const tree = screen.getByRole('tree')
    const row = (prefix: string) => {
      const match = within(tree).getAllByRole('treeitem')
        .find(item => item.textContent?.startsWith(prefix))
      expect(match).toBeDefined()
      return match as HTMLElement
    }
    const hover = (prefix: string) => {
      fireEvent.mouseOver(row(prefix))
      return screen.getByRole('button', { name: /Cop/ })
    }
    const select = (name: string) => {
      const button = screen.getByRole('button', { name: /Cop/ })
      fireEvent.contextMenu(button)
      fireEvent.click(screen.getByRole('menuitem', { name }))
    }

    fireEvent.click(hover('plain:'))
    await waitFor(() => { expect(writeText).toHaveBeenLastCalledWith('hello') })

    hover('odd-key:')
    select('Copy property path')
    await waitFor(() => { expect(writeText).toHaveBeenLastCalledWith('$["odd-key"]') })
    select('Copy JSON')
    await waitFor(() => { expect(writeText).toHaveBeenLastCalledWith('3') })
    fireEvent.click(hover('odd-key:'))
    await waitFor(() => { expect(writeText).toHaveBeenLastCalledWith('3') })

    fireEvent.click(hover('object:'))
    await waitFor(() => { expect(writeText).toHaveBeenLastCalledWith('{\n  "a": 1\n}') })
    select('Copy compact JSON')
    await waitFor(() => { expect(writeText).toHaveBeenLastCalledWith('{"a":1}') })

    for (const [prefix, expected] of [
      ['missing:', 'undefined'],
      ['big:', '7'],
      ['symbol:', 'Symbol'],
      ['symbolNamed:', 'token'],
      ['named:', 'named'],
      ['anonymous:', 'Function'],
    ] as const) {
      fireEvent.click(hover(prefix))
      await waitFor(() => { expect(writeText).toHaveBeenLastCalledWith(expected) })
    }
  })

  it('reports clipboard failure, resets feedback, and clears a prior timer', async () => {
    vi.useFakeTimers()
    writeText.mockRejectedValue(new Error('denied'))
    const view = render(<JsonTree data={{ value: 'x' }} />)
    const row = screen.getByRole('treeitem')
    fireEvent.mouseOver(row)
    fireEvent.click(screen.getByRole('button', { name: 'Copy value' }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('button', { name: 'Copy failed' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Copy failed' }))
    await act(async () => { await Promise.resolve() })
    act(() => { vi.advanceTimersByTime(1_500) })
    expect(screen.getByRole('button', { name: 'Copy value' })).toBeDefined()
    view.unmount()
  })

  it('keeps the copy action on its hovered row and clears stale targets', () => {
    const view = render(<JsonTree data={{ first: { a: 1 }, second: 2 }} />)
    const root = view.container.firstElementChild as HTMLElement
    const tree = screen.getByRole('tree')
    const firstRow = within(tree).getAllByRole('treeitem')[0] as HTMLElement
    const secondRow = within(tree).getAllByRole('treeitem')[1] as HTMLElement

    fireEvent.mouseOver(firstRow)
    const copyButton = screen.getByRole('button', { name: 'Copy pretty JSON' })
    expect(firstRow.contains(copyButton)).toBe(true)
    fireEvent.mouseOver(copyButton)
    expect(screen.getByRole('button', { name: 'Copy pretty JSON' })).toBeDefined()
    fireEvent.mouseOver(firstRow)

    fireEvent.scroll(root)

    fireEvent.contextMenu(copyButton)
    fireEvent.mouseOver(secondRow)
    fireEvent.mouseOver(root)
    fireEvent.mouseLeave(root)
    expect(screen.getByRole('menu')).toBeDefined()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: /Copy/ })).toBeNull()

    fireEvent.mouseOver(secondRow)
    expect(screen.getByRole('button', { name: 'Copy value' })).toBeDefined()
    fireEvent.mouseOver(root)
    expect(screen.queryByRole('button', { name: /Copy/ })).toBeNull()

    fireEvent.scroll(root)
    view.rerender(<JsonTree data={{ replacement: 3 }} />)
    expect(screen.queryByRole('button', { name: /Copy/ })).toBeNull()
  })

  it('copies the fixed root and clears it when the pointer leaves', async () => {
    const view = render(<JsonTree data={{ value: 1 }} />)
    const root = view.container.firstElementChild as HTMLElement
    const openingBracket = root.querySelector<HTMLElement>('[data-json-root-row]')
    expect(openingBracket).not.toBeNull()

    fireEvent.mouseOver(openingBracket as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: 'Copy pretty JSON' }))
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith('{\n  "value": 1\n}') })

    fireEvent.mouseLeave(root)
    expect(screen.queryByRole('button', { name: /Copy/ })).toBeNull()
  })
})
