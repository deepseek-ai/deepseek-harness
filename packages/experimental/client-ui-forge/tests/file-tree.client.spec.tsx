// @vitest-environment jsdom
/** Changed-file directories, searching, and keyboard disclosure without reading repository contents. */
import { useState } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ForgeDiffFile } from '../src/types.ts'
import { ChangedFiles, type ChangedFilesState } from '../src/client/ChangedFiles.tsx'
import { changedFileTree, filterFileTree } from '../src/client/file-tree.ts'
import { en } from '../src/client/locales.ts'
import { FileTreePane } from '../src/client/FileTreePane.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function file(path: string, previousPath: string | null = null): ForgeDiffFile {
  return { path, previousPath, status: previousPath === null ? 'modified' : 'renamed', binary: false, oversized: false, untracked: false, additions: 1, deletions: 0, hunks: [] }
}

it('compacts directory chains, sorts directories before files, and keeps identical basenames distinct', () => {
  const tree = changedFileTree([file('z.ts'), file('src/client/b.ts'), file('docs/a.ts'), file('src/client/a.ts')])
  expect(tree.map(node => [node.kind, node.name])).toEqual([['directory', 'docs'], ['directory', 'src/client'], ['file', 'z.ts']])
  expect(filterFileTree(tree, 'A.TS').map(node => node.path)).toEqual(['docs', 'src/client'])
  expect(filterFileTree(tree, ' ')).toBe(tree)
  expect(filterFileTree(tree, 'missing')).toEqual([])
  expect(changedFileTree([])).toEqual([])
})

it('matches renamed paths and keeps file names containing backslashes literal', () => {
  const tree = changedFileTree([file('lib/new.ts', 'src/old.ts'), file('a\\b.ts')])
  expect(filterFileTree(tree, 'old.ts').map(node => node.path)).toEqual(['lib'])
  expect(tree[1]).toMatchObject({ kind: 'file', path: 'a\\b.ts' })
})

it('preserves input order for repeated paths with distinct file metadata', () => {
  const first = file('same.ts', 'original.ts'), second = file('same.ts')
  expect(changedFileTree([file('z.ts'), first, file('a.ts'), second]).map(node => node.kind === 'file' && node.file))
    .toEqual([file('a.ts'), first, second, file('z.ts')])
})

it('searches through folded directories and restores their fold state when search is cleared', () => {
  const jump = vi.fn()
  const files = [file('src/a.ts'), file('src/b.ts'), file('README.md')]
  function Harness() {
    const [state, setState] = useState<ChangedFilesState>({ query: '', collapsed: {}, selected: null })
    return <ChangedFiles files={files} state={state} t={makeTranslate(en)} jump={jump}
      filter={(query) => { setState(value => ({ ...value, query })) }}
      toggle={(path) => { setState(value => ({ ...value, collapsed: { ...value.collapsed, [path]: !value.collapsed[path] } })) }} />
  }
  const view = render(<Harness />)
  fireEvent.keyDown(view.getByRole('button', { name: 'src' }), { key: 'ArrowRight' })
  fireEvent.keyDown(view.getByRole('button', { name: 'src' }), { key: 'Enter' })
  fireEvent.keyDown(view.getByRole('button', { name: 'src/a.ts' }), { key: 'ArrowLeft' })
  fireEvent.click(view.getByRole('button', { name: 'src' }))
  fireEvent.click(view.getByRole('button', { name: 'src' }))
  fireEvent.keyDown(view.getByRole('button', { name: 'src' }), { key: 'ArrowLeft' })
  expect(view.queryByRole('button', { name: 'src/a.ts' })).toBeNull()
  fireEvent.change(view.getByRole('textbox'), { target: { value: 'a.ts' } })
  fireEvent.click(view.getByRole('button', { name: 'src/a.ts' }))
  expect(jump).toHaveBeenCalledWith('src/a.ts')
  expect(view.queryByRole('button', { name: 'README.md' })).toBeNull()
  fireEvent.change(view.getByRole('textbox'), { target: { value: '' } })
  expect(view.queryByRole('button', { name: 'src/a.ts' })).toBeNull()
  fireEvent.keyDown(view.getByRole('button', { name: 'src' }), { key: 'ArrowRight' })
  expect(view.getByRole('button', { name: 'src/a.ts' })).toBeTruthy()
  fireEvent.change(view.getByRole('textbox'), { target: { value: 'missing' } })
  expect(view.getByText('No matching files')).toBeTruthy()
})

it('keeps text-caret navigation in the filter while other keys bubble to the menu', () => {
  const key = vi.fn()
  const view = render(<div onKeyDown={key}><ChangedFiles files={[file('new.ts', 'old.ts')]}
    state={{ query: '', collapsed: {}, selected: 'new.ts' }} t={makeTranslate(en)} filter={vi.fn()} toggle={vi.fn()} jump={vi.fn()} /></div>)
  for (const name of ['Home', 'End', 'ArrowLeft', 'ArrowRight']) fireEvent.keyDown(view.getByRole('textbox'), { key: name })
  expect(key).not.toHaveBeenCalled()
  fireEvent.keyDown(view.getByRole('textbox'), { key: 'ArrowDown' })
  expect(key).toHaveBeenCalledOnce()
  expect(view.getByRole('button').getAttribute('aria-current')).toBe('true')
})

it('bounds pointer and keyboard resizing, retains hidden width, and stops cancelled drags', () => {
  let containerWidth = 1000
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => containerWidth)
  let measure: ResizeObserverCallback = () => {}
  const disconnect = vi.spyOn(ResizeObserver.prototype, 'disconnect')
  // Capture the observer callback so a parent resize can be delivered without a layout engine.
  const NativeObserver = ResizeObserver
  vi.stubGlobal('ResizeObserver', class extends NativeObserver {
    constructor(callback: ResizeObserverCallback) { super(callback); measure = callback }
    override observe() {}
  })
  try {
    const props = { files: [file('a.ts')], state: { query: '', collapsed: {}, selected: null }, t: makeTranslate(en), filter: vi.fn(), toggle: vi.fn(), jump: vi.fn(), id: 'tree' }
    const view = render(<FileTreePane {...props} position="right" />)
    const handle = view.getByRole('separator')
    const capture = vi.fn(), release = vi.fn()
    Object.defineProperties(handle, { setPointerCapture: { value: capture }, releasePointerCapture: { value: release } })
    const width = () => Number(handle.getAttribute('aria-valuenow'))
    fireEvent.keyDown(handle, { key: 'Enter' })
    expect(width()).toBe(240)
    for (const [key, value] of [['ArrowLeft', 260], ['ArrowRight', 240], ['Home', 200], ['End', 600]] as const) {
      fireEvent.keyDown(handle, { key }); expect(width()).toBe(value)
    }
    fireEvent.keyDown(handle, { key: 'Home' })
    fireEvent.pointerDown(handle, { button: 2, pointerId: 1, clientX: 500 })
    expect(capture).not.toHaveBeenCalled()
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 300 })
    expect(width()).toBe(200)
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 500 })
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 300 })
    expect(width()).toBe(200)
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 400 })
    expect(width()).toBe(300)
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 350 })
    expect(width()).toBe(350)
    expect(release).toHaveBeenCalledWith(1)
    for (const end of [fireEvent.pointerCancel, fireEvent.lostPointerCapture]) {
      fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 500 })
      end(handle, { pointerId: 1 })
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300 })
      expect(width()).toBe(350)
    }
    view.rerender(<FileTreePane {...props} position="hidden" />)
    containerWidth = 0
    act(() => { measure([], new NativeObserver(() => {})) })
    expect(width()).toBe(350)
    containerWidth = 1000
    view.rerender(<FileTreePane {...props} position="right" />)
    act(() => { measure([], new NativeObserver(() => {})) })
    expect(width()).toBe(350)
    view.rerender(<FileTreePane {...props} position="left" />)
    expect(view.getByRole('separator')).toBe(handle)
    expect(width()).toBe(350)
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(width()).toBe(370)
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(width()).toBe(350)
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 350 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 400 })
    expect(width()).toBe(400)
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 450 })
    expect(width()).toBe(450)
    containerWidth = 600
    act(() => { measure([], new NativeObserver(() => {})) })
    expect(width()).toBe(280)
    view.unmount()
    expect(disconnect).toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }
})

it('can mount into a detached fragment without measuring a nonexistent parent element', () => {
  const observe = vi.spyOn(ResizeObserver.prototype, 'observe')
  const view = render(<FileTreePane files={[]} state={{ query: '', collapsed: {}, selected: null }} t={makeTranslate(en)}
    filter={vi.fn()} toggle={vi.fn()} jump={vi.fn()} id="detached-tree" position="right" />, { container: document.createDocumentFragment() })
  expect(observe).not.toHaveBeenCalled()
  view.unmount()
})
