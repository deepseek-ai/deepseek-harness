// @vitest-environment jsdom
/** Call-scoped preparation subscriptions and file-mutation progress. */
import { useMemo } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AssistantChatData, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { useDisclosure } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/use-disclosure.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en, zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import type { ToolCallHookContext } from '../src/client/contract/slots.ts'
import { bindToolCallArgumentsPartial } from '../src/client/tool/tool-call-arguments-partial.ts'
import { FileMutationRow } from '../src/client/tool/toolviews/file-mutation-row.tsx'

afterEach(cleanup)

const standard = {} as Parameters<typeof bindToolCallArgumentsPartial>[0]
const data = (first: string, second = ''): AssistantChatData => ({
  status: 'running', turn: 1, step: 1, time: 1,
  blocks: [
    { kind: 'text', text: 'Preparing changes' },
    { kind: 'tool-call', callId: 'first', name: 'write', argsRaw: first },
    { kind: 'tool-call', callId: 'second', name: 'edit', argsRaw: second },
  ],
})

function source(initial: AssistantChatData | undefined) {
  const store = createSnapshotStore<AssistantChatData | undefined>(initial)
  const listeners = new Set<() => void>()
  return {
    set: (value: AssistantChatData | undefined) => { store.set(value) },
    listeners,
    getSnapshot: () => store.getSnapshot(),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      const dispose = store.subscribe(listener)
      return () => { listeners.delete(listener); dispose() }
    },
  }
}

function Probe({ context, label, rendered }: { context: ToolCallHookContext; label: string; rendered: () => void }) {
  const usePartial = useMemo(() => bindToolCallArgumentsPartial(standard, context), [context])
  const raw = usePartial()
  rendered()
  return <output aria-label={label}>{raw}</output>
}

describe('tool argument prefix Hook', () => {
  it('does not subscribe until used and refreshes only the call whose prefix changed', () => {
    const assistant = source(data('{', 'second prefix'))
    const first = bindToolCallArgumentsPartial(standard, { assistant, callId: 'first' })
    expect(assistant.listeners.size).toBe(0)
    const firstRendered = vi.fn()
    const secondRendered = vi.fn()
    const firstContext = { assistant, callId: 'first' }
    const secondContext = { assistant, callId: 'second' }
    const view = render(<>
      <Probe context={firstContext} label="first" rendered={firstRendered} />
      <Probe context={secondContext} label="second" rendered={secondRendered} />
    </>)
    expect(first).toBeTypeOf('function')
    expect(assistant.listeners.size).toBe(2)
    firstRendered.mockClear()
    secondRendered.mockClear()
    act(() => { assistant.set(data('{"file_path":', 'second prefix')) })
    expect(view.getByLabelText('first').textContent).toBe('{"file_path":')
    expect(firstRendered).toHaveBeenCalled()
    expect(secondRendered).not.toHaveBeenCalled()
    firstRendered.mockClear()
    act(() => { assistant.set(data('{"file_path":', 'more second prefix')) })
    expect(firstRendered).not.toHaveBeenCalled()
    expect(view.getByLabelText('second').textContent).toBe('more second prefix')
    view.unmount()
    expect(assistant.listeners.size).toBe(0)
  })

  it('handles missing sources and calls and detaches a replaced Step source', () => {
    const old = source(undefined)
    const next = source(data('new step'))
    const rendered = vi.fn()
    const view = render(<Probe context={{ assistant: old, callId: 'missing' }} label="raw" rendered={rendered} />)
    expect(view.getByLabelText('raw').textContent).toBe('')
    act(() => { old.set(data('unrelated')) })
    expect(view.getByLabelText('raw').textContent).toBe('')
    view.rerender(<Probe context={{ assistant: next, callId: 'first' }} label="raw" rendered={rendered} />)
    expect(old.listeners.size).toBe(0)
    expect(next.listeners.size).toBe(1)
    expect(view.getByLabelText('raw').textContent).toBe('new step')
    view.rerender(<Probe context={{ assistant: undefined, callId: 'first' }} label="raw" rendered={rendered} />)
    expect(next.listeners.size).toBe(0)
    expect(view.getByLabelText('raw').textContent).toBe('')
    view.unmount()
  })

  it.each([
    ['write', en, 'Preparing content'], ['edit', zh, '正在准备内容'],
  ] as const)('%s subscribes only during preparation and rounds raw length upward', (toolName, dictionary, label) => {
    const assistant = source(data(''))
    const usePartial = bindToolCallArgumentsPartial(standard, { assistant, callId: 'first' })
    const props = {
      phase: 'preparing', toolName, callId: 'first', useToolCallArgumentsPartial: usePartial,
      block: { phase: 'preparing', callId: 'first', name: toolName, turn: 1, step: 1, time: 1, subCalls: [] },
      useDisclosure, openFile: vi.fn(), loadImage: vi.fn(), t: makeTranslate(dictionary),
    } as Parameters<typeof FileMutationRow>[0]
    const view = render(<FileMutationRow {...props} />)
    for (const [length, kilobytes] of [[0, 0], [1, 1], [1024, 1], [1025, 2], [12 * 1024, 12]]) {
      act(() => { assistant.set(data('中'.repeat(length!))) })
      expect(view.getByText(`${label} ${kilobytes}KB`)).toBeTruthy()
      expect(view.queryByRole('button')).toBeNull()
    }
    expect(assistant.listeners.size).toBe(1)
    const started = { phase: 'start' as const, callId: 'first', name: toolName, turn: 1, step: 1, time: 2, subCalls: [], argsRaw: '{"file_path":"file.txt","content":"hello"}' }
    view.rerender(<FileMutationRow {...props} phase="start" block={started} />)
    expect(assistant.listeners.size).toBe(0)
    expect(view.getByText('file.txt')).toBeTruthy()
    const result: ToolResultNode = { kind: 'tool-result', callId: 'first', seq: 3, time: 3, callTime: 2, call: { name: toolName, argsRaw: started.argsRaw }, content: [], isError: false, subCalls: [] }
    view.rerender(<FileMutationRow {...props} phase="result" block={result} />)
    expect(assistant.listeners.size).toBe(0)
    expect(view.getByText('file.txt')).toBeTruthy()
  })
})
