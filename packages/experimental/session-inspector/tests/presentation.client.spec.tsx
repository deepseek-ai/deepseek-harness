// @vitest-environment jsdom
/** The single Inspector switches sources and navigates object references inside folded table groups. */

import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate, sessionSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionInspectorView, type SessionInspectorProps } from '../src/client/views/View.tsx'
import type { InspectorChatTarget, InspectorObjectReference } from '../src/client/views/objects.ts'
import type { InspectorRecord, InspectorRow } from '../src/client/views/table-model.ts'
import { en } from '../src/client/locales.ts'
import { mainChatRoot } from '../src/client/views/chat-node/dom.ts'
import { InspectorChatPicker } from '../src/client/views/chat-node/picker.ts'
import { installInspectorTableGeometry } from './table-geometry.client.ts'

beforeEach(() => { installInspectorTableGeometry() })
afterEach(cleanup)

it('switches presentation in one table and follows a linked node through its collapsed parent', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  onTestFinished(() => { cleanup(); vi.unstubAllGlobals() })
  const step = { text: 'step content' }
  const turn = { step }
  const target = { text: 'linked content', turn }
  const source = { linked: target }
  const references = new WeakMap<object, InspectorObjectReference>()
  const linked: InspectorObjectReference = { id: 'node:target', kind: 'node', identity: 'target',
    rowKey: 'target', target: { nodeKey: 'target' }, read: () => target }
  references.set(target, linked)
  references.set(turn, { id: 'turn:1', kind: 'turn', identity: '1', target: { turn: 1 }, read: () => turn })
  references.set(step, { id: 'step:1/1', kind: 'step', identity: '1/1', target: { turn: 1, step: 1 }, read: () => step })
  const rows = createSnapshotStore<readonly InspectorRow[]>([
    { key: 'source', depth: 0 }, { key: 'group', depth: 0 }, { key: 'target', parent: 'group', depth: 1 },
  ])
  const records = new Map<string, InspectorRecord>([
    ['source', { type: 'source-type', identity: 'source', location: '', value: source }],
    ['group', { type: 'group-type', identity: 'group', location: '', value: {} }],
    ['target', { type: 'target-type', identity: 'target', location: '', value: target }],
  ])
  const log = createSnapshotStore<readonly InspectorRow[]>([{ key: 'event', depth: 0 }])
  const props: SessionInspectorProps = {
    useChatRows: bindSnapshotSelector(rows), useLogRows: bindSnapshotSelector(log),
    useChatRecord: ((key: string) => records.get(key)),
    useLogRecord: (() => ({ type: 'session/event', identity: '1', location: '', value: { text: 'log data' } })),
    useSession: bindSnapshotSelector(createSnapshotStore(sessionSnapshot('presentation-session' as SessionId))),
    objects: { sessionId: 'presentation-session' as SessionId, updates: createSnapshotStore<object>({}), reference: value => references.get(value),
      row: key => key === 'target' ? linked : undefined },
    pickRow: vi.fn((_target, mode) => mode === 'chat-node' ? 'target' : 'event'),
    recordType: (key, mode) => mode === 'chat-node' ? records.get(key)?.type : 'session/event',
    logChatTarget: vi.fn(() => ({ nodeKey: 'target', turn: 1, step: 1 })),
    chatRoot: mainChatRoot, resolveChatTargets: vi.fn((target: InspectorChatTarget) => [target]),
    pickChat: (owner, picked, cancelled) => {
      const picker = new InspectorChatPicker(mainChatRoot, owner, picked, cancelled, () => {})
      if (!picker.start()) return undefined
      return () => { picker.dispose() }
    },
    loadOlder: async () => {}, t: makeTranslate(en),
  }
  const ui = render(<SessionInspectorView {...props} />)
  expect(ui.getAllByRole('table')).toHaveLength(1)
  expect((ui.getByRole('combobox', { name: 'Presentation' }) as HTMLSelectElement).value).toBe('session-log')
  expect(ui.getByRole('columnheader', { name: 'Time (UTC)' })).toBeTruthy()
  fireEvent.change(ui.getByRole('combobox', { name: 'Presentation' }), { target: { value: 'chat-node' } })
  expect(ui.queryByRole('columnheader', { name: 'Time (UTC)' })).toBeNull()
  fireEvent.click(ui.getByRole('button', { name: 'Collapse children' }))
  expect(ui.queryByRole('button', { name: 'target-type' })).toBeNull()
  fireEvent.click(ui.getByRole('button', { name: 'source-type' }))
  fireEvent.click(ui.getByRole('button', { name: '↗ Node · target' }))
  expect(ui.getByRole('button', { name: 'target-type' }).closest('tr')?.getAttribute('aria-selected')).toBe('true')
  expect(ui.getByText('"linked content"')).toBeTruthy()
  expect(props.resolveChatTargets).toHaveBeenCalledWith({ nodeKey: 'target' })
  fireEvent.click(ui.getByRole('button', { name: '↗ Turn · 1' }))
  fireEvent.click(ui.getByRole('button', { name: '↗ Step · 1/1' }))
  const trail = () => within(ui.getByRole('navigation', { name: 'Raw data navigation' }))
  expect(trail().getAllByRole('button').map(button => button.textContent))
    .toEqual(['source-type · source', 'Node · target', 'Turn · 1', 'Step · 1/1'])
  expect(ui.getByText('"step content"')).toBeTruthy()
  fireEvent.click(trail().getByRole('button', { name: 'Turn · 1' }))
  expect(trail().queryByRole('button', { name: 'Step · 1/1' })).toBeNull()
  expect(ui.getByRole('button', { name: '↗ Step · 1/1' })).toBeTruthy()
  fireEvent.click(trail().getByRole('button', { name: 'Node · target' }))
  expect(ui.getByText('"linked content"')).toBeTruthy()
  fireEvent.click(trail().getByRole('button', { name: 'source-type · source' }))
  expect(trail().getAllByRole('button')).toHaveLength(1)
  expect(ui.getByRole('button', { name: '↗ Node · target' })).toBeTruthy()
  expect(ui.getByRole('button', { name: 'source-type' }).closest('tr')?.getAttribute('aria-selected')).toBe('true')
  expect(ui.queryByRole('button', { name: 'Return to selected row' })).toBeNull()
  fireEvent.click(ui.getByRole('button', { name: 'target-type' }))
  expect(trail().getAllByRole('button').map(button => button.textContent)).toEqual(['target-type · target'])
  fireEvent.change(ui.getByRole('combobox', { name: 'Presentation' }), { target: { value: 'session-log' } })
  expect(ui.queryByRole('navigation', { name: 'Raw data navigation' })).toBeNull()
  expect(ui.getAllByRole('table')).toHaveLength(1)
  expect(ui.getByRole('columnheader', { name: 'Time (UTC)' })).toBeTruthy()
  expect(ui.getByRole('button', { name: 'session/event' })).toBeTruthy()
  vi.mocked(props.resolveChatTargets).mockClear()
  fireEvent.click(ui.getByRole('button', { name: 'session/event' }))
  expect(props.logChatTarget).toHaveBeenCalledWith('event')
  expect(props.resolveChatTargets).toHaveBeenCalledWith({ nodeKey: 'target', turn: 1, step: 1 })
  expect((ui.getByRole('combobox', { name: 'Presentation' }) as HTMLSelectElement).value).toBe('session-log')
  expect(ui.getByText('$:').closest('ul')?.textContent).toContain('log data')
  vi.mocked(props.logChatTarget).mockReturnValueOnce(undefined)
  vi.mocked(props.resolveChatTargets).mockClear()
  fireEvent.click(ui.getByRole('button', { name: 'session/event' }))
  expect(props.resolveChatTargets).toHaveBeenCalledWith({})
  const chat = document.createElement('div')
  chat.dataset.slot = 'main.conversation'
  const view = document.createElement('div')
  view.dataset.slot = 'conversation.view'
  const flow = document.createElement('div')
  flow.dataset.chatFlow = ''
  flow.getBoundingClientRect = () => new DOMRect(0, 0, 300, 300)
  const picked = document.createElement('button')
  picked.dataset.chatNodeKey = 'target'
  picked.scrollIntoView = vi.fn()
  flow.append(picked); view.append(flow); chat.append(view); document.body.append(chat)
  onTestFinished(() => { chat.remove() })
  const hitTest = Object.getOwnPropertyDescriptor(document, 'elementsFromPoint')
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [picked] })
  onTestFinished(() => {
    if (hitTest === undefined) Reflect.deleteProperty(document, 'elementsFromPoint')
    else Object.defineProperty(document, 'elementsFromPoint', hitTest)
  })
  fireEvent.click(ui.getByRole('button', { name: en['picker.pick'] }))
  fireEvent.click(document.querySelector('[data-session-inspector-picker]')!)
  expect(props.pickRow).toHaveBeenCalledWith({ nodeKey: 'target' }, 'session-log')
  expect((ui.getByRole('combobox', { name: 'Presentation' }) as HTMLSelectElement).value).toBe('session-log')
  expect(ui.getByRole('button', { name: 'session/event' }).closest('tr')?.getAttribute('aria-selected')).toBe('true')
  expect(ui.getByRole('button', { name: en['picker.pick'] }).getAttribute('aria-pressed')).toBe('false')
  expect(ui.getByText('$:').closest('ul')?.textContent).toContain('log data')
  fireEvent.click(ui.getByRole('button', { name: en['picker.pick'] }))
  fireEvent.keyDown(document.body, { key: 'Escape' })
  expect(ui.getByRole('button', { name: en['picker.pick'] }).getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(ui.getByRole('button', { name: en['picker.pick'] }))
  fireEvent.change(ui.getByRole('combobox', { name: 'Presentation' }), { target: { value: 'chat-node' } })
  expect(ui.getByRole('button', { name: en['picker.pick'] }).getAttribute('aria-pressed')).toBe('false')
  const before = vi.mocked(props.pickRow).mock.calls.length
  fireEvent.click(picked)
  expect(vi.mocked(props.pickRow).mock.calls).toHaveLength(before)
  await act(async () => { fireEvent.click(ui.getByRole('button', { name: en['filter.title'] })) })
  expect(ui.getByRole('option', { name: 'target-type' })).toBeTruthy()
  fireEvent.click(ui.getByRole('option', { name: 'target-type' }))
  vi.mocked(props.pickRow).mockReturnValueOnce(undefined)
  fireEvent.click(ui.getByRole('button', { name: en['picker.pick'] }))
  fireEvent.click(document.querySelector('[data-session-inspector-picker]')!)
  expect(ui.getByRole('status').textContent).toBe(en['picker.noMatch'])
  expect(ui.getByRole('button', { name: en['picker.pick'] }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(document.querySelector('[data-session-inspector-picker]')!)
  expect(ui.getByRole('button', { name: en['picker.pick'] }).getAttribute('aria-pressed')).toBe('false')
  chat.remove()
  fireEvent.click(ui.getByRole('button', { name: en['picker.pick'] }))
  expect(ui.getByRole('status').textContent).toBe(en['picker.noChat'])
})
