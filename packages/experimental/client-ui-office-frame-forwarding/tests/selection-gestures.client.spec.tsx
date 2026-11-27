// @vitest-environment jsdom
/** Read-only dragging inside a native selection starts a new range without moving content. */
import { createElement, type MouseEvent } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { OfficeInput } from '../src/client/input.ts'
import { usePreviewInteraction } from '../src/client/usePreviewInteraction.tsx'
import { useOfficeSelection } from '../src/client/useOfficeSelection.tsx'
import type { OfficeInteractionContext } from '../src/client/interaction.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { OfficeDocumentId } from '../src/types.ts'

const cases = [
  { format: 'docx', selection: '1004, 3164, 3855, 413', x: 2000, y: 3350, next: '2037, 3164, 1521, 413' },
  { format: 'xlsx', selection: '0, 2520, 4787, 2805', x: 2000, y: 2900, next: '0, 2775, 4787, 765' },
] as const

afterEach(cleanup)

function fixture(spec: typeof cases[number], preview = false) {
  const input = new OfficeInput(), calls: object[] = [], first = Promise.withResolvers<{ text?: string }>()
  const fail = vi.fn(), focus = vi.fn()
  const documentId = brandString<OfficeDocumentId>('selection')
  const record = async (value: object) => {
    calls.push(value)
    const reply = calls.length === 1 ? await first.promise : {}
    return { documentId, text: reply.text ?? '' }
  }
  const request: OfficeInteractionContext['request'] = {
    command: record, input: record, presentation: record, selection: mime => record({ mime }),
  }
  const viewportRef = { current: document.createElement('div') as HTMLDivElement | null }
  const context: OfficeInteractionContext = {
    documentType: spec.format === 'docx' ? 'text' : 'spreadsheet',
    t: key => key,
    request, send: {
      command: value => input.send(() => request.command(value)), input: value => input.send(() => request.input(value)),
      presentation: value => input.send(() => request.presentation(value)), selection: mime => input.send(() => request.selection(mime)),
    }, inputQueue: { current: input },
    action: (operation) => { void operation().catch(fail) }, failAction: fail,
    settling: { current: false }, playbackTransition: { current: undefined }, playing: false, busy: false, renderFailure: undefined,
    contentView: () => viewportRef.current === null ? undefined : ({ x: viewportRef.current.scrollLeft * 15,
      y: viewportRef.current.scrollTop * 15, scale: 1 / 15 }),
  }
  let selection: ReturnType<typeof useOfficeSelection> | ReturnType<typeof usePreviewInteraction>
  function Harness() {
    selection = preview ? usePreviewInteraction(context) : useOfficeSelection(context, focus)
    return createElement('div', { onKeyDown: 'key' in selection ? selection.key : undefined }, selection.overlay, createElement('canvas', {
      onMouseDown: (event: MouseEvent<HTMLCanvasElement>) => { selection.pointer(event, 0) },
      onMouseMove: (event: MouseEvent<HTMLCanvasElement>) => { selection.pointer(event, 2) },
      onMouseUp: (event: MouseEvent<HTMLCanvasElement>) => { selection.pointer(event, 1) },
      onMouseLeave: () => { selection.cancelPointer() },
    }))
  }
  const view = render(createElement(Harness))
  act(() => { selection.callback({ type: 2, payload: spec.selection }) })
  const canvas = view.container.querySelector('canvas')!
  const at = { clientX: spec.x / 15, clientY: spec.y / 15, buttons: 1, detail: 1 }
  return {
    view, canvas, at, calls, first, focus, fail, input, context, viewportRef, selection: () => selection,
    rerender: () => { view.rerender(createElement(Harness)) }, callback: (payload: string) => { selection.callback({ type: 2, payload }) },
  }
}

test.each(cases)('$format: a new range starts inside the old selection while native input is pending', async (spec) => {
  const f = fixture(spec)
  fireEvent.mouseDown(f.canvas, f.at)
  fireEvent.mouseMove(f.canvas, { ...f.at, clientX: (spec.x + 1600) / 15, clientY: (spec.y + 500) / 15 })
  fireEvent.mouseUp(f.canvas, { ...f.at, clientX: (spec.x + 1600) / 15, clientY: (spec.y + 500) / 15, buttons: 0 })
  expect(f.calls).toHaveLength(1)
  await act(async () => { f.first.resolve({}); await f.input.send(async () => {}) })
  expect(f.calls).toEqual([
    { op: 'mouse', type: 0, x: spec.x, y: spec.y, count: 1, buttons: 1, modifiers: 0 },
    { op: 'mouse', type: 1, x: spec.x, y: spec.y, count: 1, buttons: 1, modifiers: 0 },
    { op: 'mouse', type: 0, x: spec.x, y: spec.y, count: 1, buttons: 1, modifiers: 0 },
    { op: 'mouse', type: 2, x: spec.x + 1600, y: spec.y + 500, count: 1, buttons: 1, modifiers: 0 },
    { op: 'mouse', type: 1, x: spec.x + 1600, y: spec.y + 500, count: 1, buttons: 1, modifiers: 0 },
  ])
  act(() => { f.callback(spec.next) })
  expect([...f.view.container.querySelectorAll<HTMLElement>('[data-office-selection]')].map(element => ({
    left: element.style.left, top: element.style.top, width: element.style.width, height: element.style.height,
  }))).toMatchSnapshot(`${spec.format} replacement selection`)
  expect(f.focus).toHaveBeenCalledOnce()
  expect(f.fail).not.toHaveBeenCalled()
})

test('Word starts a fresh drag when its left indent snaps to the selected line', async () => {
  const f = fixture(cases[0])
  fireEvent.mouseDown(f.canvas, { ...f.at, clientX: 5 })
  fireEvent.mouseMove(f.canvas, f.at)
  fireEvent.mouseUp(f.canvas, { ...f.at, buttons: 0 })
  await act(async () => { f.first.resolve({}); await f.input.send(async () => {}) })
  expect(f.calls.map(value => 'type' in value ? value.type : undefined)).toEqual([0, 1, 0, 2, 1])
})

test.each([
  { name: 'Shift range extension', event: { shiftKey: true } },
  { name: 'right click', event: { buttons: 2 } },
  { name: 'double click', event: { detail: 2 } },
  { name: 'outside selection', event: { clientX: 0, clientY: 0 } },
])('$name keeps its native gesture', async ({ event }) => {
  const f = fixture(cases[0])
  fireEvent.mouseDown(f.canvas, { ...f.at, ...event })
  fireEvent.mouseLeave(f.canvas)
  await act(async () => { f.first.resolve({}); await f.input.send(async () => {}) })
  expect(f.calls.map(value => 'type' in value ? value.type : undefined)).toEqual([0, 1])
  expect(f.fail).not.toHaveBeenCalled()
})

test('read-only keyboard permits navigation, select-all and copy while refusing mutation', async () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const write = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } })
  vi.stubGlobal('ClipboardItem', class { constructor(readonly items: Record<string, Blob>) {} })
  const f = fixture(cases[0], true)
  try {
    const textarea = f.view.container.querySelector('textarea')!
    for (const event of [{ key: 'a', ctrlKey: true }, { key: 'c', metaKey: true },
      { key: 'ArrowDown', shiftKey: true, ctrlKey: true, altKey: true }, { key: 'Escape', shiftKey: true }, { key: 'ArrowUp' }, { key: 's', ctrlKey: true }, { key: 'x' }]) fireEvent.keyDown(textarea, event)
    await act(async () => { f.first.resolve({ text: 'selected' }); await f.input.send(async () => {}) })
    expect(f.calls).toEqual([
      { command: 'SelectAll', arguments: {} }, { mime: 'text/plain;charset=utf-8' }, { mime: 'text/html' },
      { op: 'key', type: 0, character: 0, key: 1024 | 4096 | 8192 | 16384 }, { op: 'key', type: 0, character: 0, key: 1281 }, { op: 'key', type: 0, character: 0, key: 1025 },
    ])
    fireEvent.paste(textarea); fireEvent.cut(textarea); fireEvent.copy(textarea)
    await act(async () => { await f.input.send(async () => {}) })
    expect(write).toHaveBeenCalledTimes(2)
    const interaction = f.selection()
    if (!('isInputTarget' in interaction)) throw new Error('Preview interaction was not mounted')
    interaction.focus(); expect(document.activeElement).toBe(textarea)
    expect(interaction.isInputTarget(textarea)).toBe(true)
    expect(interaction.isInputTarget(f.canvas)).toBe(false)
    expect(f.fail).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllGlobals()
    if (original) Object.defineProperty(navigator, 'clipboard', original); else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

test.each(['settling', 'playing', 'renderFailure'] as const)('read-only keyboard stops during %s', (mode) => {
  const f = fixture(cases[0], true)
  if (mode === 'settling') f.context.settling.current = true
  else if (mode === 'playing') f.context.playing = true
  else f.context[mode] = 'stopped'
  f.rerender()
  fireEvent.keyDown(f.view.container.firstElementChild!, { key: 'ArrowLeft' })
  expect(f.calls).toEqual([])
  if (mode === 'settling' || mode === 'renderFailure') fireEvent.copy(f.view.container.querySelector('textarea')!)
  expect(f.calls).toEqual([])
})

test('selection callbacks and header gestures preserve read-only geometry and focus', async () => {
  const f = fixture(cases[1])
  act(() => {
    f.selection().callback({ type: 17, payload: '15,30,45,60,1,2' })
    f.selection().callback({ type: 6, payload: '15,30,45,60,0' })
    f.selection().callback({ type: 18, payload: 'grabbing' })
  })
  expect(f.view.container.querySelector('[data-office-cell-cursor]')).not.toBeNull()
  expect(f.view.container.querySelector('[data-office-graphic-selection]')).not.toBeNull()
  expect(f.selection().cursor).toBe('default')
  act(() => { f.selection().callback({ type: 18, payload: 'text' }) })
  expect(f.selection().cursor).toBe('text')
  f.selection().selectHeader()
  await act(async () => { f.first.resolve({}); await f.input.send(async () => {}) })
  expect(f.calls).toEqual([{ command: 'SelectAll', arguments: {} }, { command: 'SelectAll', arguments: {} }])
  const button = document.createElement('button'); button.dataset.range = 'A:A'
  const header = render(createElement('div', { onClick: f.selection().headerClick }, createElement('button', { 'data-range': 'A:A' }, 'A')))
  fireEvent.click(header.getByRole('button'))
  await act(async () => { await f.input.send(async () => {}) })
  expect(f.calls.at(-1)).toMatchObject({ command: 'GoToCell' })
  f.context.busy = true; f.rerender(); f.selection().selectHeader('B:B')
  expect(f.calls).toHaveLength(3)
  act(() => { f.selection().reset() })
  expect(f.view.container.querySelectorAll('[data-office-selection], [data-office-cell-cursor], [data-office-graphic-selection]')).toHaveLength(0)
})

test('pointer movement maps buttons and modifiers, and header clicks need a range', async () => {
  const f = fixture(cases[0])
  try {
    act(() => { f.selection().callback({ type: 6, payload: '100,200,300,400,0,{"handles":{}}' }) })
    expect(f.view.container.querySelector('[data-office-graphic-selection]')).not.toBeNull()
    act(() => { f.selection().callback({ type: 18, payload: 'move' }) })
    expect(f.selection().cursor).toBe('default')
    fireEvent.mouseMove(f.canvas, { ...f.at, buttons: 4, ctrlKey: true, altKey: true })
    await act(async () => { f.first.resolve({}); await f.input.send(async () => {}) })
    expect(f.calls[0]).toMatchObject({ type: 2, buttons: 2, modifiers: 8192 | 16384 })
    const header = render(createElement('div', { onClick: f.selection().headerClick }, createElement('span', {}, 'empty header')))
    fireEvent.click(header.getByText('empty header'))
    expect(f.calls).toHaveLength(1)
    f.viewportRef.current = null; f.rerender()
    fireEvent.mouseDown(f.canvas, f.at)
    expect(f.calls).toHaveLength(1)
    f.context.playing = true; f.rerender()
    fireEvent.mouseDown(f.canvas, f.at); fireEvent.mouseUp(f.canvas, f.at)
    await act(async () => { await f.input.send(async () => {}) })
    expect(f.calls.at(-1)).toEqual({ action: 'next' })
  } finally { cleanup() }
})


test('unpaired mouse-up and failed-engine pointer gestures cannot submit native input', () => {
  const f = fixture(cases[0])
  fireEvent.mouseUp(f.canvas, f.at)
  expect(f.calls).toHaveLength(0)
  f.context.renderFailure = 'engine lost'; f.rerender()
  fireEvent.mouseDown(f.canvas, f.at)
  expect(f.calls).toHaveLength(0)
})

test('callbacks without a payload clear geometry and canceled gestures respect a settling owner', async () => {
  const f = fixture(cases[0])
  act(() => { f.selection().callback({ type: 2 }) })
  expect(f.view.container.querySelectorAll('[data-office-selection]')).toHaveLength(0)
  fireEvent.mouseDown(f.canvas, { ...f.at, detail: 0 })
  f.context.settling.current = true
  fireEvent.mouseLeave(f.canvas)
  await act(async () => { f.first.resolve({}); await f.input.send(async () => {}) })
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]).toMatchObject({ count: 1 })
})
