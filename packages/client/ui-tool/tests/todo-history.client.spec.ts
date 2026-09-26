/** Recorded todo predecessors follow incremental history repair and nested invocations. */
import { describe, expect, it } from 'vitest'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { todoCallDefinition, todoHistoryView, todoWriteDefinition, type TodoHistory } from '../src/client/tool/models/todo-history.ts'
import { todoDiffModel } from '../src/client/tool/models/todo-diff-model.ts'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'

const t = makeTranslate(en, commonEn)
const first = [{ content: 'Build', status: 'in_progress' }, { content: 'Review', status: 'pending' }, { content: 'Old task', status: 'pending' }] as const
const second = [{ content: 'Build', status: 'completed' }, { content: 'Review', status: 'pending' }, { content: 'Publish', status: 'pending' }] as const

function entry(seq: number, type: string, data: unknown): SessionLiveEventEntry {
  return { type: 'event', event: { seq, time: 1000 + seq, type, data } as SessionEvent }
}

function call(todos: unknown): ToolResultNode {
  return { kind: 'tool-result', seq: 20, time: 2000, callTime: 1000, callId: 'second', call: { name: 'todo_write', argsRaw: JSON.stringify({ todos }) }, content: [], isError: false, subCalls: [] }
}

function runtime() {
  const assembler = new ConversationNodeAssembler(
    { entries: () => [todoWriteDefinition, todoCallDefinition], fallbackEntry: () => undefined },
    { entries: () => [todoHistoryView] },
  )
  assembler.activateTarget('tool-todo-history')
  return assembler
}

function history(assembler: ConversationNodeAssembler): TodoHistory {
  assembler.flush()
  return assembler.snapshot('tool-todo-history') as TodoHistory
}

describe('recorded todo history', () => {
  it('repairs a missing predecessor on prepend and keeps earlier cards fixed after a later write', () => {
    const assembler = runtime()
    assembler.replaceWindow([entry(10, 'tool/call', { callId: 'second', name: 'todo_write', arguments: JSON.stringify({ todos: second }), turn: 1, step: 1 })], true)
    expect(todoDiffModel(call(second), history(assembler).get('second'), true, t)?.summary).toBeNull()
    assembler.prepend([entry(5, 'todo/write', { todos: first })], false)
    const baseline = history(assembler).get('second')
    expect(todoDiffModel(call(second), baseline, false, t)?.summary).toBe('1 added · 1 updated · 1 removed')
    assembler.append(entry(11, 'todo/write', { todos: second }))
    expect(history(assembler).get('second')).toEqual(baseline)
    assembler.append(entry(12, 'tool/ptc-dispatch-start', { parentCallId: 'root', rootCallId: 'root', subCallId: 'nested', name: 'todo_write', arguments: { todos: [] } }))
    expect(history(assembler).get('nested')?.todos).toEqual(second)
    assembler.replaceWindow([], false)
    expect(history(assembler).get('second')).toBeUndefined()
  })

  it('shows first-write additions, status transitions, removals, and unchanged items separately', () => {
    expect(todoDiffModel(call(first), { todos: undefined }, false, t)?.summary).toBe('3 added')
    const diff = todoDiffModel(call(second), { todos: first }, false, t)
    expect(diff?.details.items).toMatchObject([
      { title: 'Build', previousStatus: 'In progress', change: { value: 'updated' } },
      { title: 'Publish', change: { value: 'added' } },
      { title: 'Old task', change: { value: 'removed' } },
    ])
    expect(diff?.details.unchanged?.items.map(item => item.title)).toEqual(['Review'])
    expect(todoDiffModel(call(second), { todos: second }, false, t)?.summary).toBe('No changes to the list')
    expect(todoDiffModel(call([]), { todos: undefined }, false, t)?.details.empty).toBe('The to-do list is empty')
    expect(todoDiffModel({ ...call(first), isError: true }, { todos: undefined }, false, t)).toBeNull()
    expect(todoDiffModel(call(first), undefined, false, t)?.details.caption).toBe('Previous list unavailable')
  })

  it('publishes immutable lookup snapshots when the index changes', () => {
    const view = todoHistoryView.create()
    const firstSnapshot = view.replace({ nodes: [{ id: 'call-1', data: { todos: first } }] } as never)
    const secondSnapshot = view.apply({ upserts: [{ id: 'call-1', data: { todos: second } }] } as never)
    expect(firstSnapshot.get('call-1')?.todos).toEqual(first)
    expect(secondSnapshot.get('call-1')?.todos).toEqual(second)
    expect(view.empty.get('call-1')).toBeUndefined()
  })

  it('distinguishes relative reordering from positions shifted by an insertion', () => {
    const moved = todoDiffModel(call([first[1], first[0], first[2]]), { todos: first }, false, t)
    expect(moved?.details.items.map(item => item.change?.label)).toEqual(['Reordered', 'Reordered'])
    const inserted = todoDiffModel(call([{ content: 'New', status: 'pending' }, ...first]), { todos: first }, false, t)
    expect(inserted?.summary).toBe('1 added')
  })
})
