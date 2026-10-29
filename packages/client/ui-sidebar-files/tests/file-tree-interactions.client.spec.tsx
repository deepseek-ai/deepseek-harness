// @vitest-environment jsdom
/** Interactive accessories stay outside the primary action and its disabled scope. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { TreeFixture as FileTree } from './tree-fixture.client.tsx'
import type { Accessory } from './tree-fixture.client.tsx'
import type { FileTreeInput, TreeEntry, TreeEntryKind } from '../src/client/FileTree.tsx'

afterEach(() => { cleanup() })

type TestInput = FileTreeInput & { accessory?: Accessory | undefined }

function ActionAccessory({ entry }: { entry: TreeEntry }) {
  return <button onClick={() => { actions.get(entry.path)?.() }}>Action</button>
}
const actions = new Map<string, () => void>()
afterEach(() => { actions.clear() })

const file: TreeEntry = { path: 'pr/src/a', name: 'First.txt', meta: { kind: 'file', size: 1 } }

function draw(overrides: Partial<TestInput> = {}) {
  const onOpen = vi.fn<TestInput['onOpen']>()
  const props: TestInput = { root: 'pr', entries: [file], expanded: ['pr/src'], onOpen, onToggle: vi.fn(), ...overrides }
  const view = render(<FileTree {...props} />)
  return { view, onOpen }
}

it.each<TreeEntryKind>(['file', 'directory', 'other'])('keeps a %s accessory button outside the primary action and its disabled scope', (kind) => {
  const accessory = vi.fn()
  const onToggle = vi.fn()
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const entry = { ...file, meta: { kind } }
    actions.set(entry.path, accessory)
    const onOpen = vi.fn()
    const view = render(<FileTree root="pr/src" entries={[entry]} expanded={[]} onOpen={onOpen} onToggle={onToggle}
      accessory={ActionAccessory} />)
    const action = view.getByRole('button', { name: 'Action' })
    fireEvent.click(action)
    expect(accessory).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()
    expect(onToggle).not.toHaveBeenCalled()
    expect(view.container.querySelector('button button')).toBeNull()
    expect(action.closest('[aria-disabled="true"]')).toBeNull()
    expect(diagnostic).not.toHaveBeenCalled()
    if (kind !== 'other') {
      fireEvent.click(view.getByRole('button', { name: file.name }))
      if (kind === 'file') expect(onOpen).toHaveBeenCalledWith(entry)
      else expect(onToggle).toHaveBeenCalledWith(entry, true)
    }
  } finally {
    diagnostic.mockRestore()
  }
})

it('leaves an accessory enabled when the caller refuses to open its file', () => {
  const accessory = vi.fn()
  actions.set(file.path, accessory)
  const { view, onOpen } = draw({ root: 'pr/src', canOpen: () => false, accessory: ActionAccessory })
  const action = view.getByRole('button', { name: 'Action' })
  expect(action.closest('[aria-disabled="true"]')).toBeNull()
  fireEvent.click(action)
  expect(accessory).toHaveBeenCalledTimes(1)
  expect(onOpen).not.toHaveBeenCalled()
})
