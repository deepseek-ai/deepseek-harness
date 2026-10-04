// @vitest-environment jsdom
/** Virtual Inspector rows expose raw data and flash on updates. */

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { bindSnapshotSelector, makeTranslate, RemoteError, sessionSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { InspectorTable, type InspectorTableProps } from '../src/client/views/InspectorTable.tsx'
import type { InspectorRecord, InspectorRow } from '../src/client/views/table-model.ts'
import type { InspectorObjectReference } from '../src/client/views/objects.ts'
import { en } from '../src/client/locales.ts'
import { chatNodeWithLocation } from './chat-node-fixture.client.ts'
import { installInspectorTableGeometry } from './table-geometry.client.ts'

beforeEach(() => { installInspectorTableGeometry() })
afterEach(cleanup)

it('uses the merged reasoning preview only when folded and preserves raw block-start fields', () => {
  const rows = createSnapshotStore<readonly InspectorRow[]>([
    { key: 'block', depth: 0, disclosure: 'closed' }, { key: 'delta', depth: 1, parent: 'block' },
  ])
  const records = new Map<string, InspectorRecord>([
    ['block', { type: 'block-start', identity: '0', location: '1/1',
      value: { type: 'block-start', index: 7, blockType: 'reasoning' }, collapsedSummary: 'blockType: reasoning · merged deltas' }],
    ['delta', { type: 'reasoning-delta', identity: '1', location: '1/1', value: { type: 'reasoning-delta', index: 7, text: 'merged deltas' } }],
  ])
  const props: InspectorTableProps = {
    title: 'Session Log', flash: false, showTime: true, useRows: bindSnapshotSelector(rows),
    useRecord: ((key: string) => records.get(key)),
    typeOf: key => records.get(key)?.type,
    useSession: bindSnapshotSelector(createSnapshotStore(sessionSnapshot('fold-preview' as SessionId))),
    loadOlder: async () => {}, t: makeTranslate(en),
  }
  const ui = render(<InspectorTable {...props} />)
  fireEvent.click(ui.getByRole('button', { name: 'blockType: reasoning · merged deltas' }))
  expect(ui.getByText('$:').closest('ul')?.textContent).toContain('index: 7')
  expect(ui.getByText('$:').closest('ul')?.textContent).not.toContain('merged deltas')
  fireEvent.click(ui.getByRole('button', { name: 'Expand children' }))
  expect(ui.getByRole('button', { name: 'index: 7 · blockType: reasoning' })).toBeTruthy()
  expect(ui.queryByRole('button', { name: 'blockType: reasoning · merged deltas' })).toBeNull()
  fireEvent.click(ui.getByRole('button', { name: 'Collapse children' }))
  expect(ui.getByRole('button', { name: 'blockType: reasoning · merged deltas' })).toBeTruthy()
})

it('omits type and sequence fields only from the horizontal data preview', () => {
  const rows = createSnapshotStore<readonly InspectorRow[]>([{ key: 'event', depth: 0 }])
  const record: InspectorRecord = { type: 'assistant/message', identity: '9', location: '', value: {
    type: 'assistant/message', seq: 9, sequence: 10, time: 123,
    data: { type: 'reasoning', seq: 2, sequence: 3, text: 'delta' },
  } }
  const props: InspectorTableProps = {
    title: 'Session Log', flash: false, showTime: true, useRows: bindSnapshotSelector(rows),
    useRecord: ((key: string) => key === 'event' ? record : undefined),
    typeOf: key => key === 'event' ? record.type : undefined,
    useSession: bindSnapshotSelector(createSnapshotStore(sessionSnapshot('preview-session' as SessionId))),
    loadOlder: async () => {}, t: makeTranslate(en),
  }
  const ui = render(<InspectorTable {...props} />)
  expect(ui.getByRole('columnheader', { name: 'Time (UTC)' })).toBeTruthy()
  expect(ui.getByRole('button', { name: 'assistant/message' })).toBeTruthy()
  fireEvent.click(ui.getByRole('button', { name: 'delta' }))
  const raw = ui.getByText('$:').closest('ul')!.textContent
  expect(raw).toContain('type: "reasoning"')
  expect(raw).toContain('seq: 9')
  expect(raw).toContain('sequence: 3')
  expect(raw).toContain('time: 123')
  expect(ui.queryByRole('navigation')).toBeNull()
  expect(ui.container.querySelectorAll('details:not([open])')).toHaveLength(0)
})

it('virtualizes the table and updates the selected row in place with an animation', () => {
  const previous = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
  const cancel = vi.fn()
  const animate = vi.fn(() => ({ cancel }))
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: animate })
  onTestFinished(() => {
    if (previous === undefined) Reflect.deleteProperty(Element.prototype, 'animate')
    else Object.defineProperty(Element.prototype, 'animate', previous)
  })
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  onTestFinished(() => { vi.unstubAllGlobals() })
  const rows = createSnapshotStore<readonly InspectorRow[]>(Array.from({ length: 1000 }, (_, index) => ({ key: String(index), depth: 0 })))
  const records = new Map(rows.getSnapshot().map(row => [row.key, {
    type: `node-${row.key}`, identity: row.key, location: '1/1', value: { text: `original-${row.key}` },
  } satisfies InspectorRecord]))
  const recordHook = () => ((key: string) => records.get(key)) as InspectorTableProps['useRecord']
  const props: InspectorTableProps = {
    title: 'Chat Node', flash: true, showTime: false, useRows: bindSnapshotSelector(rows), useRecord: recordHook(),
    typeOf: key => records.get(key)?.type,
    useSession: bindSnapshotSelector(createSnapshotStore(sessionSnapshot('table-session' as SessionId))), loadOlder: vi.fn(async () => {}), t: makeTranslate(en),
  }
  const ui = render(<InspectorTable {...props} />)
  expect(ui.queryByRole('columnheader', { name: 'Time (UTC)' })).toBeNull()
  expect(ui.getAllByRole('columnheader')).toHaveLength(4)
  expect([...ui.container.querySelectorAll('td[colspan]')].every(cell => cell.getAttribute('colspan') === '4')).toBe(true)
  expect(ui.getAllByRole('row').length).toBeLessThan(100)
  const button = ui.getAllByRole('button').find(candidate => candidate.textContent?.startsWith('node-'))!
  const key = button.textContent.slice('node-'.length)
  const row = button.closest('tr')
  fireEvent.click(button)
  expect(ui.getByText(`"original-${key}"`, { exact: false })).toBeTruthy()
  expect(animate).not.toHaveBeenCalled()
  records.set(key, { type: `node-${key}`, identity: key, location: '1/1', value: { text: 'updated' } })
  ui.rerender(<InspectorTable {...props} useRecord={recordHook()} />)
  expect(ui.getByRole('button', { name: `node-${key}` }).closest('tr')).toBe(row)
  expect(ui.getByText('"updated"', { exact: false })).toBeTruthy()
  expect(animate).toHaveBeenCalledOnce()
  ui.unmount()
  expect(cancel).toHaveBeenCalled()
})

it('opens cyclic raw nodes, contains formatter errors, and permits closing and reopening details', () => {
  const node = chatNodeWithLocation()
  const rows = createSnapshotStore<readonly InspectorRow[]>([{ key: 'node', depth: 0 }, { key: 'error', depth: 0 }])
  const records = new Map<string, InspectorRecord>([
    ['node', { type: node.kind, identity: node.key, location: '1/1', value: node }],
    ['error', { type: 'unserializable', identity: 'error', location: '', value: {
      toJSON() { throw new Error('unavailable value') },
    } }],
  ])
  const props: InspectorTableProps = {
    title: 'Chat Node', flash: false, showTime: false, useRows: bindSnapshotSelector(rows),
    useRecord: ((key: string) => records.get(key)),
    typeOf: key => records.get(key)?.type,
    useSession: bindSnapshotSelector(createSnapshotStore(sessionSnapshot('details-session' as SessionId))),
    loadOlder: async () => {}, t: makeTranslate(en),
  }
  const ui = render(<InspectorTable {...props} />)
  fireEvent.click(ui.getByRole('button', { name: 'assistant' }))
  expect(ui.getByText('$:').closest('ul')!.textContent).toContain('[Circular]')
  fireEvent.click(ui.getByRole('button', { name: 'unserializable' }))
  expect(ui.getByRole('alert').textContent).toContain('unavailable value')
  fireEvent.click(ui.getByRole('button', { name: 'assistant' }))
  expect(ui.queryByRole('alert')).toBeNull()
  fireEvent.click(ui.getByRole('button', { name: 'Close' }))
  expect(ui.queryByText('$:')).toBeNull()
  fireEvent.click(ui.getByRole('button', { name: 'assistant' }))
  expect(ui.getByText('$:').closest('ul')!.textContent).toContain('node content')
  ui.unmount()
  const reopened = render(<InspectorTable {...props} />)
  fireEvent.click(reopened.getByRole('button', { name: 'assistant' }))
  expect(reopened.getByText('$:').closest('ul')!.textContent).toContain('[Circular]')
})

it('shows the complete row identity in a tooltip outside the table clipping area', () => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  onTestFinished(() => { cleanup(); vi.unstubAllGlobals() })
  const identity = 'assistant:long-node-identity-that-does-not-fit-the-id-column'
  const rows = createSnapshotStore<readonly InspectorRow[]>([{ key: identity, depth: 0 }])
  const record: InspectorRecord = { type: 'assistant', identity, location: '', value: {} }
  const props: InspectorTableProps = {
    title: 'Chat Node', flash: false, showTime: false, useRows: bindSnapshotSelector(rows),
    useRecord: ((key: string) => key === identity ? record : undefined),
    typeOf: key => key === identity ? record.type : undefined,
    useSession: bindSnapshotSelector(createSnapshotStore(sessionSnapshot('tooltip-session' as SessionId))),
    loadOlder: async () => {}, t: makeTranslate(en),
  }
  const ui = render(<InspectorTable {...props} />)
  const id = ui.getByText(identity)
  fireEvent.mouseEnter(id)
  const tooltip = ui.getByRole('tooltip', { hidden: true })
  expect(tooltip.textContent).toBe(identity)
  expect(tooltip.parentElement).toBe(document.body)
  expect(ui.container.contains(tooltip)).toBe(false)
  fireEvent.mouseLeave(id)
  expect(ui.queryByRole('tooltip', { hidden: true })).toBeNull()
})

it('handles empty history, pagination retry, loading state, and removal of the selected record', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  onTestFinished(() => { cleanup(); vi.unstubAllGlobals() })
  const rows = createSnapshotStore<readonly InspectorRow[]>([])
  const session = createSnapshotStore({ ...sessionSnapshot('paging-session' as SessionId), hasMore: true })
  const records = new Map<string, InspectorRecord>()
  const retried = Promise.withResolvers<undefined>()
  const loadOlder = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('page unavailable')).mockReturnValueOnce(retried.promise)
  const props: InspectorTableProps = {
    title: 'Session Log', flash: false, showTime: true,
    useRows: bindSnapshotSelector(rows), useSession: bindSnapshotSelector(session), useRecord: (key: string) => records.get(key),
    typeOf: key => records.get(key)?.type, loadOlder, t: makeTranslate(en),
  }
  const ui = render(<InspectorTable {...props} />)
  expect(ui.getByText(en['table.empty'])).toBeTruthy()
  await act(async () => { fireEvent.click(ui.getByRole('button', { name: en['table.older'] })) })
  expect(ui.getByRole('alert').textContent).toContain('page unavailable')
  fireEvent.click(ui.getByRole('button', { name: en['table.older'] }))
  act(() => { session.set({ ...session.getSnapshot(), loadingOlder: true }) })
  expect((ui.getByRole('button', { name: en['table.loading'] }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => {
    retried.resolve(undefined)
    session.set({ ...session.getSnapshot(), loadingOlder: false, hasMore: false })
  })
  expect(ui.queryByRole('alert')).toBeNull()
  expect(loadOlder).toHaveBeenCalledTimes(2)
  records.set('row', { type: 'kept-type', identity: 'row', location: '', time: 0, value: { text: 'kept' } })
  act(() => { rows.set([{ key: 'row', parent: 'unloaded-parent', depth: 1 }]) })
  ui.rerender(<InspectorTable {...props} pickedRow={{ key: 'row' }} />)
  expect(ui.getByText('00:00:00.000')).toBeTruthy()
  expect(ui.getByText('$:').closest('ul')?.textContent).toContain('kept')
  records.delete('row')
  ui.rerender(<InspectorTable {...props} />)
  expect(ui.container.querySelector('pre')?.textContent).toBe(en['table.removed'])
  act(() => { session.set({ ...session.getSnapshot(), openState: 'error',
    openError: new RemoteError('gateway/internal', 'Session unavailable', {}) }) })
  expect(ui.getByRole('alert').textContent).toBe('Session unavailable')
})

it('keeps reference details navigable after their table row has disappeared', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  onTestFinished(() => { cleanup(); vi.unstubAllGlobals() })
  const child = { text: 'reference value' }
  const reference: InspectorObjectReference = { id: 'retired', kind: 'node', identity: 'retired',
    rowKey: 'removed-row', target: {}, read: () => child }
  const rows = createSnapshotStore<readonly InspectorRow[]>([{ key: 'original', depth: 0 }])
  const record: InspectorRecord = { type: 'node', identity: 'original', location: '', value: { linked: child } }
  const props: InspectorTableProps = {
    title: 'Chat Node', flash: false, showTime: false, useRows: bindSnapshotSelector(rows),
    useRecord: (key: string) => key === 'original' ? record : undefined, typeOf: () => 'node',
    useSession: bindSnapshotSelector(createSnapshotStore(sessionSnapshot('retired-row-session' as SessionId))),
    objects: { sessionId: 'retired-row-session' as SessionId, updates: createSnapshotStore<object>({}),
      reference: value => value === child ? reference : undefined, row: () => undefined },
    loadOlder: async () => {}, t: makeTranslate(en),
  }
  const ui = render(<InspectorTable {...props} />)
  fireEvent.click(ui.getByRole('button', { name: 'node' }))
  fireEvent.click(ui.getByRole('button', { name: '↗ Node · retired' }))
  expect(ui.getByText('"reference value"')).toBeTruthy()
  fireEvent.click(ui.getByRole('button', { name: 'node · original' }))
  expect(ui.getByRole('button', { name: '↗ Node · retired' })).toBeTruthy()
})
