// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useDisclosure } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/use-disclosure.ts'
import type { StartedToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { en as common } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
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

type Props = Parameters<typeof TodoRow>[0] & Parameters<typeof ReadImageRow>[0]

function preparation(name: string): Props {
  return {
    phase: 'preparing', callId: 'call', toolName: name,
    block: { phase: 'preparing', callId: 'call', name, turn: 1, step: 1, time: 1, subCalls: [] },
    t: makeTranslate(en, common), useDisclosure, useToolCallArgumentsPartial: vi.fn(() => ''), openFile: vi.fn(), loadImage: vi.fn(),
    useTodoHistory: vi.fn(), useSession: vi.fn(() => false), renderSlot: vi.fn(() => null),
  } as Props
}

describe('argument-free tool preparation', () => {
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

  it('replaces preparation with the dispatched row and retains that row through the result', () => {
    const props = preparation('write')
    const view = render(<FileMutationRow {...props} />)
    const preparingRow = view.container.querySelector('[data-tool="write"]')
    vi.mocked(props.useToolCallArgumentsPartial).mockClear()
    const started: StartedToolCall = {
      phase: 'start', callId: 'call', name: 'write', turn: 1, step: 1, time: 2, subCalls: [],
      argsRaw: '{"file_path":"hello.txt","content":"hello"}',
    }
    view.rerender(<FileMutationRow {...props} phase="start" block={started} />)
    const row = view.container.querySelector('[data-tool="write"]')
    expect(row).not.toBe(preparingRow)
    expect(props.useToolCallArgumentsPartial).not.toHaveBeenCalled()
    expect(view.getByText('hello.txt')).toBeTruthy()
    expect(view.container.querySelector('[data-state="running"]')).not.toBeNull()
    const result: ToolResultNode = {
      kind: 'tool-result', seq: 3, time: 3, callId: 'call', callTime: 2,
      call: { name: 'write', argsRaw: started.argsRaw }, content: [], isError: false, subCalls: [],
    }
    view.rerender(<FileMutationRow {...props} phase="result" block={result} />)
    expect(view.container.querySelector('[data-tool="write"]')).toBe(row)
    expect(props.useToolCallArgumentsPartial).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-state="ok"]')).not.toBeNull()
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
      phase: 'start', callId: 'call', name, turn: 1, step: 1, time: 2, subCalls: [],
      argsRaw: '{"prompt":"Inspect this file"}',
    }
    view.rerender(<Component {...props} phase="start" block={started} />)
    expect(view.getByText(title, { exact: true })).toBeTruthy()
    expect(view.getByText(summary, { exact: true })).toBeTruthy()
    expect(view.getByRole('button', { expanded: false })).toBeTruthy()
    const result: ToolResultNode = {
      kind: 'tool-result', seq: 3, time: 3, callId: 'call', callTime: 2,
      call: { name, argsRaw: started.argsRaw }, content: [], isError: false, subCalls: [],
    }
    view.rerender(<Component {...props} phase="result" block={result} />)
    expect(view.getByText(title, { exact: true })).toBeTruthy()
    expect(view.getByText(summary, { exact: true })).toBeTruthy()
  })

  it('keeps specialized Bash session hooks outside its preparation branch', () => {
    const useSessions = vi.fn(() => { throw new Error('Bash call details are unavailable during preparation') })
    const view = render(<BashRow {...preparation('bash')} useSessions={useSessions} />)
    expect(view.container.querySelector('[data-state="preparing"]')).not.toBeNull()
    expect(useSessions).not.toHaveBeenCalled()
    expect(view.queryByRole('button')).toBeNull()
  })
})
