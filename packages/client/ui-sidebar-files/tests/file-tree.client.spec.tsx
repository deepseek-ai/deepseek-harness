// @vitest-environment jsdom
/** The file tree over data that is not a workspace listing: a pull request's changed files. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { TreeFixture as FileTree } from './tree-fixture.client.tsx'
import type { Accessory } from './tree-fixture.client.tsx'
import { en } from '../src/client/locales.ts'
import type { FileTreeInput, TreeEntry } from '../src/client/FileTree.tsx'

afterEach(() => { cleanup() })

const labels = {
  loading: en.loading, empty: en.empty, truncated: en.truncated, noViewer: en['entry.noViewer'], other: en['entry.other'],
}

type TestInput = FileTreeInput & { accessory?: Accessory | undefined }

/** Caller-owned status data stays outside tree entries. */
const statuses: Readonly<Record<string, string>> = { 'pr/src/file10.ts': 'added' }
function ChangeAccessory({ entry }: { entry: TreeEntry }) {
  return statuses[entry.path] === undefined ? null : <em>{statuses[entry.path]}</em>
}
function EmptyAccessory() { return null }
function ZeroAccessory() { return 0 }

/** A pull request's changed files, flattened by the caller and listed in no particular order. */
const CHANGES: readonly TreeEntry[] = [
  { path: 'pr/src/file10.ts', name: 'file10.ts', meta: { kind: 'file' } },
  { path: 'pr/README.md', name: 'README.md', meta: { kind: 'file' } },
  { path: 'pr/src', name: 'src', meta: { kind: 'directory' } },
  { path: 'pr/src/file2.ts', name: 'file2.ts', meta: { kind: 'file' } },
  { path: 'pr/src/util', name: 'util', meta: { kind: 'directory' } },
  { path: 'pr/src/util/a.ts', name: 'a.ts', meta: { kind: 'file' } },
  { path: 'pr/Assets', name: 'Assets', meta: { kind: 'directory' } },
  { path: 'pr/link', name: 'link', meta: { kind: 'other' } },
]

/** Draw the tree with recording callbacks; `rerender` redraws it with changed input. */
function draw(input: Partial<TestInput> & Pick<TestInput, 'entries'>) {
  const onToggle = vi.fn<TestInput['onToggle']>()
  const onOpen = vi.fn<TestInput['onOpen']>()
  const props = (next: Partial<TestInput>): TestInput => ({
    root: 'pr', expanded: [], onToggle, onOpen, ...input, ...next,
  })
  const view = render(<FileTree {...props({})} />)
  const rerender = (next: Partial<TestInput>): void => { view.rerender(<FileTree {...props(next)} />) }
  return { view, onToggle, onOpen, rerender }
}

/** The drawn rows' keys, in document order. */
function paths(root: HTMLElement): string[] {
  return [...root.querySelectorAll('[data-files-entry]')].map(row => row.getAttribute('data-files-path')!)
}

/** One drawn row's pressable or listed element. */
function row(root: HTMLElement, path: string): HTMLElement {
  const item = [...root.querySelectorAll('[data-files-path]')].find(candidate => candidate.getAttribute('data-files-path') === path)
  return item!.firstElementChild!.firstElementChild as HTMLElement
}

/** The drawn rows' names and kinds, in document order. */
function rows(root: HTMLElement): string[] {
  return [...root.querySelectorAll('[data-files-entry]')]
    .map(item => `${item.getAttribute('data-files-entry')} ${item.querySelector('span')!.textContent}`)
}

describe('FileTree', () => {
  it('draws the root level, and a directory\'s level only while it is expanded, directories first, then in natural name order', () => {
    const { view, rerender } = draw({ entries: CHANGES })
    expect(paths(view.container)).toEqual(['pr/Assets', 'pr/src', 'pr/link', 'pr/README.md'])
    expect(row(view.container, 'pr/Assets').getAttribute('aria-expanded')).toBe('false')
    rerender({ expanded: ['pr/src', 'pr/src/util'] })
    expect(paths(view.container)).toEqual(['pr/Assets', 'pr/src', 'pr/src/util', 'pr/src/util/a.ts', 'pr/src/file2.ts', 'pr/src/file10.ts', 'pr/link', 'pr/README.md'])
    expect(row(view.container, 'pr/src').getAttribute('aria-expanded')).toBe('true')
  })

  it('asks the caller to expand a collapsed directory and to collapse an expanded one, with its entry', () => {
    const { view, onToggle } = draw({ entries: CHANGES, expanded: ['pr/src'] })
    fireEvent.click(row(view.container, 'pr/Assets'))
    fireEvent.click(row(view.container, 'pr/src'))
    expect(onToggle.mock.calls).toEqual([[CHANGES[6], true], [CHANGES[2], false]])
    expect(onToggle.mock.calls[0]![0]).toBe(CHANGES[6])
  })

  it('hands a pressed file to the caller, and lists anything else without opening it', () => {
    const { view, onOpen } = draw({ entries: CHANGES })
    fireEvent.click(row(view.container, 'pr/README.md'))
    expect(onOpen).toHaveBeenCalledWith(CHANGES[1])
    const other = row(view.container, 'pr/link')
    expect(other.getAttribute('aria-disabled')).toBe('true')
    expect(other.title).toBe(labels.other)
    fireEvent.click(other)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('dims a file the caller refuses and says why', () => {
    const canOpen = vi.fn((entry: TreeEntry) => entry.name !== 'README.md')
    const { view, onOpen } = draw({ entries: CHANGES, canOpen, expanded: ['pr/src'] })
    const refused = row(view.container, 'pr/README.md')
    expect(refused.getAttribute('aria-disabled')).toBe('true')
    expect(refused.title).toBe(labels.noViewer)
    expect(refused.querySelector('svg')).not.toBeNull()
    fireEvent.click(refused)
    expect(onOpen).not.toHaveBeenCalled()
    expect(row(view.container, 'pr/src/file2.ts').tagName).toBe('BUTTON')
    expect(canOpen).not.toHaveBeenCalledWith(expect.objectContaining({ meta: { kind: 'directory' } }))
  })

  it('leaves the browser context menu available without caller-supplied handlers', () => {
    const { view } = draw({ entries: CHANGES })
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    act(() => { row(view.container, 'pr/README.md').dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(false)
    expect(view.queryByRole('menuitem')).toBeNull()
  })

  it('draws each directory\'s state: loading in place of its entries, then failure, empty, and truncation notes', () => {
    const { view, rerender } = draw({ entries: CHANGES, expanded: ['pr/src', 'pr/Assets'], directories: { 'pr/src': { loading: true } } })
    const notes = (): (string | null)[][] => [...view.container.querySelectorAll('[data-files-row]')]
      .map(note => [note.getAttribute('data-files-row'), note.textContent])
    expect(notes()).toEqual([['empty', labels.empty], ['loading', labels.loading]])
    rerender({
      expanded: ['pr/src', 'pr/Assets'],
      directories: { 'pr': { truncated: true }, 'pr/src': { failure: 'Gone', truncated: true }, 'pr/Assets': { failure: 'Denied' } },
    })
    expect(notes()).toEqual([['failed', 'Denied'], ['failed', 'Gone'], ['truncated', labels.truncated], ['truncated', labels.truncated]])
    expect(paths(view.container)).toContain('pr/src/file2.ts')
    rerender({ root: 'empty', entries: [] })
    expect(notes()).toEqual([['empty', labels.empty]])
  })

  it('orders only drawn levels, and orders a drawn level again only when its names or directories change', () => {
    // Every ordering compares names through the collator, so its comparisons count the sorts.
    const compare = vi.spyOn(Intl.Collator.prototype, 'compare', 'get')
    try {
      const { view, rerender } = draw({ entries: CHANGES, expanded: ['pr/src'] })
      expect(compare).toHaveBeenCalled()
      compare.mockClear()
      // New entry objects with changed metadata must reach callbacks without another sort.
      const relisted = CHANGES.map(entry => ({ ...entry, meta: { ...entry.meta, size: 2 } }))
      const onOpen = vi.fn<FileTreeInput['onOpen']>()
      rerender({ expanded: ['pr/src'], entries: relisted, directories: { 'pr/src': { truncated: true } }, onOpen })
      expect(compare).not.toHaveBeenCalled()
      fireEvent.click(row(view.container, 'pr/src/file10.ts'))
      expect(onOpen.mock.calls[0]![0]).toBe(relisted[0])
      const added: TreeEntry = { path: 'pr/src/util/b.ts', name: 'b.ts' }
      rerender({ expanded: ['pr/src'], entries: [...CHANGES, added] })
      expect(compare).not.toHaveBeenCalled()
      rerender({ expanded: ['pr/src', 'pr/src/util'], entries: [...CHANGES, added] })
      expect(compare).toHaveBeenCalledTimes(1)
      expect(paths(view.container)).toContain('pr/src/util/b.ts')
      compare.mockClear()
      rerender({ expanded: ['pr/src', 'pr/src/util'], entries: [...CHANGES, { ...added, name: 'c.ts' }] })
      expect(compare).toHaveBeenCalledTimes(1)
    } finally {
      compare.mockRestore()
    }
  })

  it.each(['src', ''])('omits the root entry for root %j even when its key is expanded', (root) => {
    const directory = root === '' ? 'nested' : `${root}/nested`
    const file = `${directory}/a.ts`
    const { view, rerender } = draw({
      root,
      entries: [
        { path: root, name: 'Root', meta: { kind: 'directory' } },
        { path: file, name: 'a.ts' },
      ],
    })
    expect(paths(view.container)).toEqual([directory])
    expect(view.queryByRole('button', { name: 'Root' })).toBeNull()
    rerender({ expanded: [root, directory] })
    expect(paths(view.container)).toEqual([directory, file])
    expect(view.queryByRole('button', { name: 'Root' })).toBeNull()
  })

  it('puts an entry whose path has no slash under the root, whatever the root', () => {
    const { view, rerender } = draw({ entries: [
      { path: 'README.md', name: 'README.md' },
      { path: 'pr/docs', name: 'docs', meta: { kind: 'directory' } },
    ] })
    expect(paths(view.container)).toEqual(['pr/docs', 'README.md'])
    rerender({ root: '' })
    expect(paths(view.container)).toEqual(['pr', 'README.md'])
  })

  it('draws an empty root with entries at the top level given by name alone or after a slash, adding each implied directory once', () => {
    const { view } = draw({
      root: '',
      entries: [
        { path: 'docs/guide.md', name: 'guide.md' },
        { path: 'docs', name: 'Documentation', meta: { kind: 'directory' } },
        { path: 'README.md', name: 'README.md' },
        { path: '/etc/hosts', name: 'hosts' },
        { path: '/etc/ssh/config', name: 'config' },
      ],
      expanded: ['docs', '/etc', '/etc/ssh'],
    })
    expect(paths(view.container)).toEqual(['docs', 'docs/guide.md', '/etc', '/etc/ssh', '/etc/ssh/config', '/etc/hosts', 'README.md'])
    expect(rows(view.container)).toEqual([
      'directory Documentation', 'file guide.md', 'directory etc', 'directory ssh', 'file config', 'file hosts', 'file README.md',
    ])
  })

  it('adds the directories a path implies, and keeps the caller\'s own directory entry', () => {
    const own: TreeEntry = { path: 'pr/src', name: 'Sources', meta: { kind: 'directory', hidden: true } }
    const { view, onToggle } = draw({
      entries: [{ path: 'pr/src/lib/a.ts', name: 'a.ts' }, own],
      expanded: ['pr/src', 'pr/src/lib'],
    })
    expect(rows(view.container)).toEqual(['directory Sources', 'directory lib', 'file a.ts'])
    fireEvent.click(row(view.container, 'pr/src/lib'))
    fireEvent.click(row(view.container, 'pr/src'))
    expect(onToggle.mock.calls).toEqual([[{ path: 'pr/src/lib', name: 'lib', meta: { kind: 'directory' } }, false], [own, false]])
  })

  it('takes an entry without a kind as a directory when entries lie below it, and as a file otherwise', () => {
    const { view } = draw({ entries: [
      { path: 'pr/lib', name: 'lib' },
      { path: 'pr/lib/a.ts', name: 'a.ts' },
      { path: 'pr/notes', name: 'notes' },
      { path: 'pr/empty', name: 'empty', meta: { kind: 'directory' } },
    ], expanded: ['pr/empty'] })
    expect(rows(view.container)).toEqual(['directory empty', 'directory lib', 'file notes'])
    expect(view.container.querySelector('[data-files-row="empty"]')?.textContent).toBe(labels.empty)
  })

  it('draws the caller\'s name, which need not end the path, and splits paths only at a slash', () => {
    const { view } = draw({
      root: 'C:\\PROGRA~1\\repo',
      entries: [
        { path: 'C:\\PROGRA~1\\repo/LONGFO~1', name: 'Long folder name', meta: { kind: 'directory' } },
        { path: 'C:\\PROGRA~1\\repo/LONGFO~1/a.ts', name: 'a.ts' },
        { path: 'C:\\PROGRA~1\\repo/back\\slash/b.ts', name: 'b.ts' },
      ],
      expanded: ['C:\\PROGRA~1\\repo/LONGFO~1'],
    })
    expect(rows(view.container)).toEqual(['directory back\\slash', 'directory Long folder name', 'file a.ts'])
    view.rerender(<FileTree root={'\\\\server\\share'} entries={[{ path: '\\\\server\\share/Data', name: 'Data' }]} expanded={[]}
      onToggle={() => {}} onOpen={() => {}} />)
    expect(rows(view.container)).toEqual(['file Data'])
  })

  it('draws no entry outside the root and expanded directories, never adds the empty key, and draws a repeated path once', () => {
    const { view } = draw({ entries: [
      { path: '/elsewhere', name: 'elsewhere' }, { path: 'pr/a.ts', name: 'a.ts' }, { path: 'pr/a.ts', name: 'again.ts' },
    ] })
    expect(rows(view.container)).toEqual(['file a.ts'])
  })

  it('draws a local accessory from caller-owned data by path and subdues hidden rows', () => {
    const { view } = draw({
      entries: [...CHANGES, { path: 'pr/.env', name: '.env', meta: { hidden: true } }],
      accessory: ChangeAccessory, expanded: ['pr/src'],
    })
    expect(row(view.container, 'pr/src/file10.ts').parentElement!.textContent).toBe('file10.tsadded')
    expect(row(view.container, 'pr/.env').className).not.toBe(row(view.container, 'pr/README.md').className)
  })

  it.each<[string, Accessory | undefined]>([['missing', undefined], ['empty', EmptyAccessory]])(
    'keeps %s wrappers empty and CSS-hidden until content (including 0) renders', (_name, accessory) => {
      const { view, rerender } = draw({ entries: CHANGES, canOpen: entry => entry.name !== 'file2.ts', expanded: ['pr/src'], accessory })
      const examples = ['pr/src', 'pr/README.md', 'pr/link', 'pr/src/file2.ts']
      for (const path of examples) expect(row(view.container, path).nextElementSibling?.childNodes).toHaveLength(0)
      rerender({ expanded: ['pr/src'], accessory: ZeroAccessory })
      for (const path of examples) expect(row(view.container, path).nextElementSibling?.textContent).toBe('0')
      // jsdom does not install CSS Modules; pin the rule that removes the empty wrapper from layout.
      const sheet = readFileSync(resolve(import.meta.dirname, '../src/client/FileTree.module.css'), 'utf8')
      expect(/\.accessory:empty \{\s*display: none;\s*\}/.test(sheet)).toBe(true)
    },
  )

  it('subdues hidden rows with the secondary ink, which stays readable in both themes', () => {
    const sheet = readFileSync(resolve(import.meta.dirname, '../src/client/FileTree.module.css'), 'utf8')
    expect(/\.hidden \{\s*color: var\(--dsw-alias-label-secondary\);\s*\}/.test(sheet)).toBe(true)
  })

  it('marks the current file and hands its row to the caller', () => {
    const currentRef = vi.fn<(row: HTMLElement | null) => void>()
    const { view, rerender } = draw({ entries: CHANGES, expanded: ['pr/src'], current: 'pr/src/file2.ts', currentRef })
    const current = row(view.container, 'pr/src/file2.ts')
    expect(current.getAttribute('aria-current')).toBe('true')
    expect(view.container.querySelectorAll('[aria-current]')).toHaveLength(1)
    expect(currentRef).toHaveBeenLastCalledWith(current)
    rerender({ expanded: [], current: 'pr/src/file2.ts', currentRef })
    expect(currentRef).toHaveBeenLastCalledWith(null)
  })
})
