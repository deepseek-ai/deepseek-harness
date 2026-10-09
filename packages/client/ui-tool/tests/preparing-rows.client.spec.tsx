// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useDisclosure } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/use-disclosure.ts'
import type { StartedToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { en as common } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { GenericToolCard } from '../src/client/tool/toolviews/GenericToolCard.tsx'
import { FileMutationRow } from '../src/client/tool/toolviews/file-mutation-row.tsx'
import { ReadRow } from '../src/client/tool/toolviews/read-row.tsx'
import { ReadImageRow } from '../src/client/tool/toolviews/read-image-row.tsx'
import { SearchRow } from '../src/client/tool/toolviews/search-row.tsx'
import { WebRow } from '../src/client/tool/toolviews/web-row.tsx'
import { DetailsRow } from '../src/client/tool/toolviews/details-row.tsx'
import { TodoRow } from '../src/client/tool/toolviews/todo-row.tsx'
import { AskQuestionRow } from '../src/client/tool/toolviews/ask-question-row.tsx'
import { BashRow } from '../src/client/tool/toolviews/bash-sample.tsx'
import { parsedToolCall } from '../src/client/tool/models/raw-tool-call.ts'
import { toolRowModel } from '../src/client/tool/models/tool-call-model.ts'

afterEach(cleanup)

type Props = Parameters<typeof TodoRow>[0] & Parameters<typeof ReadImageRow>[0] & Parameters<typeof AskQuestionRow>[0]

function preparation(name: string, args = new PartialArguments()): Extract<Props, { phase: 'preparing' }> {
  return {
    phase: 'preparing', callId: 'call', toolName: name,
    block: { phase: 'preparing', args, callId: 'call', name, turn: 1, step: 1, time: 1, subCalls: [] },
    cwd: '/workspace', t: makeTranslate(en, common), useDisclosure, openFile: vi.fn(), loadImage: vi.fn(),
    useTodoHistory: vi.fn(), useSession: vi.fn(() => false), renderSlot: vi.fn(() => null),
    useProjection: vi.fn(() => undefined), revealPanel: vi.fn(() => false), reviewPanel: vi.fn(() => false),
  } as Extract<Props, { phase: 'preparing' }>
}

describe('tool preparation', () => {
  it.each(['read', 'write', 'edit'])('%s does not expose a malformed completed path as a file link', (name) => {
    const args = PartialArguments.fromText(String.raw`{"file_path":"unsafe.txt\q"}`)
    const props = preparation(name, args)
    expect(toolRowModel(name, props.block).filePath).toBeUndefined()
    expect(args.invalid).toBe(true)
  })

  it.each([
    ['read', ReadRow], ['read_image', ReadImageRow], ['write', FileMutationRow], ['edit', FileMutationRow],
    ['grep', SearchRow], ['glob', SearchRow], ['web_search', WebRow], ['web_fetch', WebRow],
    ['todo_write', TodoRow], ['ask_user_question', AskQuestionRow], ['subagent', DetailsRow],
    ['run_code', GenericToolCard], ['custom_tool', GenericToolCard],
  ] as const)('%s has a tool-owned prefix without arguments or disclosure', (name, Component) => {
    const props = preparation(name)
    const view = render(<Component {...props} />)
    expect(view.container.querySelector('[data-state="preparing"]')).not.toBeNull()
    expect(view.container.querySelector('svg')).not.toBeNull()
    expect(view.container.textContent?.trim()).not.toBe('')
    expect(view.queryByRole('button')).toBeNull()
    expect(view.container.querySelector('pre')).toBeNull()
    expect(parsedToolCall(props.block)).toBeNull()
    expect(toolRowModel(name, props.block)).toMatchObject({ state: 'preparing', bodyRaw: null, output: null, filePath: undefined })
    fireEvent.click(view.container.firstElementChild!)
    fireEvent.keyDown(view.container.firstElementChild!, { key: 'Enter' })
    expect(view.container.querySelector('[aria-expanded="true"]')).toBeNull()
  })

  it.each([['write', 'content'], ['edit', 'new_string']])('%s hides content progress without a path', (name, field) => {
    const args = new PartialArguments()
    args.append(`{"${field}":"hello`)
    const view = render(<FileMutationRow {...preparation(name, args)} />)
    expect(view.queryByText('1KB')).toBeNull()
    expect(view.queryByRole('button')).toBeNull()
  })

  it('retains the file row through streamed arguments, dispatch, and result', () => {
    const args = new PartialArguments()
    const props = preparation('write', args)
    const view = render(<FileMutationRow {...props} />)
    const preparingRow = view.container.querySelector('[data-tool="write"]')
    args.append('{"file_path":"hello')
    view.rerender(<FileMutationRow {...props} block={{ ...props.block }} />)
    expect(view.queryByRole('button')).toBeNull()
    args.append('.txt"')
    view.rerender(<FileMutationRow {...props} block={{ ...props.block }} />)
    expect(view.getByText('hello.txt')).toBeTruthy()
    expect(view.queryByText('1KB')).toBeNull()
    args.append(',"content":"hello')
    view.rerender(<FileMutationRow {...props} block={{ ...props.block }} />)
    expect(view.getByText('hello.txt')).toBeTruthy()
    expect(view.getByText('1KB')).toBeTruthy()
    args.append('"}')
    view.rerender(<FileMutationRow {...props} block={{ ...props.block }} />)
    expect(view.getByText('1KB')).toBeTruthy()
    fireEvent.click(view.getByText('hello.txt'))
    expect(props.openFile).not.toHaveBeenCalled()
    const started: StartedToolCall = {
      phase: 'start', args: PartialArguments.fromText('{"file_path":"hello.txt","content":"hello"}'), callId: 'call', name: 'write', turn: 1, step: 1, time: 2, subCalls: [],
      argsRaw: '{"file_path":"hello.txt","content":"hello"}',
    }
    view.rerender(<FileMutationRow {...props} phase="start" block={started} />)
    const row = view.container.querySelector('[data-tool="write"]')
    expect(row).toBe(preparingRow)
    expect(view.getByText('hello.txt')).toBeTruthy()
    expect(view.container.querySelector('[data-state="running"]')).not.toBeNull()
    expect(view.getByText('1KB')).toBeTruthy()
    expect(row?.textContent).toMatch(/1KB.*\+1 -0/)
    fireEvent.click(view.getByText('hello.txt'))
    expect(props.openFile).not.toHaveBeenCalled()
    const result: ToolResultNode = {
      kind: 'tool-result', seq: 3, time: 3, callId: 'call', callTime: 2,
      name: 'write', args: PartialArguments.fromText(started.argsRaw),
      call: { name: 'write', argsRaw: started.argsRaw }, content: [], isError: false, subCalls: [],
      meta: { operation: 'create', path: '/workspace/hello.txt' },
    }
    view.rerender(<FileMutationRow {...props} phase="result" block={result} />)
    expect(view.container.querySelector('[data-tool="write"]')).toBe(row)
    expect(view.container.querySelector('[data-state="ok"]')).not.toBeNull()
    expect(view.getByText('1KB')).toBeTruthy()
    expect(row?.textContent).toMatch(/1KB.*\+1 -0/)
    fireEvent.click(view.getByRole('button', { name: 'hello.txt' }))
    expect(props.openFile).toHaveBeenCalledWith('/workspace/hello.txt')
  })

  it('keeps the combined edit size before diff totals in every stage', () => {
    const argsRaw = JSON.stringify({ file_path: 'hello.txt', old_string: 'a'.repeat(600), new_string: 'b'.repeat(425) })
    const args = PartialArguments.fromText(argsRaw)
    const props = preparation('edit', args)
    const view = render(<FileMutationRow {...props} />)
    const row = view.container.querySelector('[data-tool="edit"]')
    expect(view.getByText('2KB')).toBeTruthy()
    const started: StartedToolCall = { ...props.block, phase: 'start', argsRaw }
    view.rerender(<FileMutationRow {...props} phase="start" block={started} />)
    expect(row?.textContent).toMatch(/2KB.*\+1 -1/)
    const result: ToolResultNode = {
      kind: 'tool-result', seq: 3, time: 3, callId: 'call', callTime: 2,
      name: 'edit', args, call: { name: 'edit', argsRaw }, content: [], isError: false, subCalls: [],
      meta: { diffs: [{ path: 'hello.txt', oldText: 'before', newText: 'after' }] },
    }
    view.rerender(<FileMutationRow {...props} phase="result" block={result} />)
    expect(view.container.querySelector('[data-tool="edit"]')).toBe(row)
    expect(row?.textContent).toMatch(/2KB.*\+1 -1/)
  })

  it.each([
    ['custom_tool', GenericToolCard, 'Tool call', 'custom_tool · Inspect this file'],
    ['subagent', DetailsRow, 'Create subagent', 'Inspect this file'],
  ] as const)('%s retains its title and tool-name rule when arguments arrive', (name, Component, title, summary) => {
    const props = preparation(name)
    const view = render(<Component {...props} />)
    expect(view.getByText(title, { exact: true })).toBeTruthy()
    expect(toolRowModel(name, props.block).summary).toBe(name === 'custom_tool' ? name : '')
    expect(view.queryByText(name, { exact: true }) !== null).toBe(name === 'custom_tool')
    expect(view.queryByRole('button')).toBeNull()
    const started: StartedToolCall = {
      phase: 'start', args: PartialArguments.fromText('{"prompt":"Inspect this file"}'), callId: 'call', name, turn: 1, step: 1, time: 2, subCalls: [],
      argsRaw: '{"prompt":"Inspect this file"}',
    }
    view.rerender(<Component {...props} phase="start" block={started} />)
    expect(view.getByText(title, { exact: true })).toBeTruthy()
    expect(view.getByText(summary, { exact: true })).toBeTruthy()
    expect(view.getByRole('button', { expanded: false })).toBeTruthy()
    const result: ToolResultNode = {
      kind: 'tool-result', seq: 3, time: 3, callId: 'call', callTime: 2,
      name, args: PartialArguments.fromText(started.argsRaw),
      call: { name, argsRaw: started.argsRaw }, content: [], isError: false, subCalls: [],
    }
    view.rerender(<Component {...props} phase="result" block={result} />)
    expect(view.getByText(title, { exact: true })).toBeTruthy()
    expect(view.getByText(summary, { exact: true })).toBeTruthy()
  })

  it('updates edit progress when the combined strings cross a kilobyte', () => {
    const args = new PartialArguments()
    args.append(`{"file_path":"hello.txt","old_string":"${'a'.repeat(600)}","new_string":"`)
    const props = preparation('edit', args)
    const view = render(<FileMutationRow {...props} />)
    expect(view.getByText('1KB')).toBeTruthy()
    args.append('b'.repeat(424))
    expect(args.refresh()).toBe(false)
    args.append('b')
    expect(args.refresh()).toBe(true)
    view.rerender(<FileMutationRow {...props} block={{ ...props.block }} />)
    expect(view.getByText('2KB')).toBeTruthy()
  })

  it('shows a streamed Bash description without enabling expansion', () => {
    const args = new PartialArguments()
    args.append('{"description":"List files')
    const view = render(<BashRow {...preparation('bash', args)} useSessions={vi.fn()} />)
    expect(view.container.querySelector('[data-state="preparing"]')).not.toBeNull()
    expect(view.getByText('List files')).toBeTruthy()
    expect(view.queryByRole('button')).toBeNull()
  })
})
