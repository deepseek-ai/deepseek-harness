// @vitest-environment jsdom
/** Real Factory composition, local Component identity, locale, and missing-definition fallback. */
import { useState } from 'react'
import { act, fireEvent } from '@testing-library/react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { makeTranslate, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { FactoryLocalComponentPropsOf, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import { FileTree } from '../src/client/FileTree.tsx'
import type { FileTreeInput } from '../src/client/FileTree.tsx'
import { en } from '../src/client/locales.ts'

function CounterAccessory({ entry }: FactoryLocalComponentPropsOf<'sidebar.files.tree', 'accessory'>) {
  const [count, setCount] = useState(0)
  return <button onClick={() => { setCount(value => value + 1) }}>{entry.path}: {count}</button>
}

function EmptyAccessory() { return null }

it('composes independent local accessories and preserves their state across input updates', async () => {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const revision = { revision: 0 }
  runtime.slots.installLocale({
    getSnapshot: () => revision, subscribe: () => () => {}, bind: () => makeTranslate(en),
  })
  const unregister = runtime.slots.registerFactory({
    name: 'sidebar.files.tree', scope: 'root', locale: 'sidebarFiles', slots: { accessory: { scope: 'root' } },
  }, FileTree)
  const onOpen = vi.fn()
  let input: FileTreeInput = {
    root: 'pr', entries: [{ path: 'pr/a', name: 'a' }], expanded: [], onToggle: vi.fn(), onOpen,
  }
  let rerender = () => {}
  await runtime.root.declare({}, function Root({ renderFactorySlot }: PropsRenderFactories) {
    const [, update] = useState(0)
    rerender = () => { update(value => value + 1) }
    return <>
      <section data-case="custom">{renderFactorySlot('sidebar.files.tree', input, { slots: { accessory: CounterAccessory }, fallback: <p>Unavailable</p> })}</section>
      <section data-case="default">{renderFactorySlot('sidebar.files.tree', input)}</section>
      <section data-case="empty">{renderFactorySlot('sidebar.files.tree', input, { slots: { accessory: EmptyAccessory } })}</section>
    </>
  })
  const view = runtime.renderRoot()
  fireEvent.click(view.getByRole('button', { name: 'pr/a: 0' }))
  expect(view.getByRole('button', { name: 'pr/a: 1' })).toBeTruthy()
  expect(onOpen).not.toHaveBeenCalled()
  for (const variant of ['default', 'empty']) {
    expect(view.container.querySelector(`[data-case="${variant}"] [data-files-path] button`)?.nextElementSibling?.childNodes).toHaveLength(0)
  }
  input = { ...input, entries: [{ path: 'pr/a', name: 'renamed' }] }
  act(() => { rerender() })
  expect(view.getByRole('button', { name: 'pr/a: 1' })).toBeTruthy()
  input = { ...input, entries: [] }
  act(() => { rerender() })
  expect(view.getAllByText(en.empty)).toHaveLength(3)
  await act(async () => { unregister() })
  expect(view.getByText('Unavailable')).toBeTruthy()
  expect(view.container.querySelector('[data-case="default"]')?.textContent).toBe('')
})
