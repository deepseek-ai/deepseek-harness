import { toolSessionEvents } from './tool-fixtures.client.ts'
// @vitest-environment jsdom
/** Tool assembly acceptance through the real ui-conversation host. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, waitFor } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ISession } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { TodoItem } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  apply as applyChat, inject as injectChat, type ToolResultNode,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotTestRuntime, TestRemote, usePinnedBrowserLanguages, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyConversation, inject as injectConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply as applyTool, inject as injectTool } from '../src/client/apply.ts'

// The service reads its initial locale from the browser; these specs assert
// the shipped Chinese copy, so they state the browser they assume.
usePinnedBrowserLanguages('zh-CN')

const SID = 's1' as SessionId

/** jsdom has no ResizeObserver; the composer seat publishes its height through one. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})
const TODOS: TodoItem[] = [
  { content: '梳理需求', status: 'completed' },
  { content: '实现 fixture 样本', status: 'in_progress' },
  { content: '浏览器验收', status: 'pending' },
]

const todoResult = (seq: number): ToolResultNode => ({
  kind: 'tool-result', seq, time: seq * 1_000, callId: `todo-${seq}`,
  call: { name: 'todo_write', argsRaw: JSON.stringify({ todos: TODOS }) },
  callTime: seq * 1_000 - 500,
  content: [], isError: false, subCalls: [],
})

const bashResult = (seq: number, callId: string, over?: Partial<ToolResultNode>): ToolResultNode => ({
  kind: 'tool-result', seq, time: seq * 1_000, callId,
  call: { name: 'bash', argsRaw: '{"command":"ls -la","description":"List files"}' },
  callTime: seq * 1_000 - 500,
  content: [{ type: 'text', text: 'total 2\ndemo.txt\n' }], isError: false,
  subCalls: [],
  ...over,
})

/** Test-owned AppFrame role: declares and renders the resident conversation area. */
type AppRootProps = PropsRenderSlots<'main'>
function AppRoot({ renderSlot }: AppRootProps) {
  return <>{renderSlot('main', {}, { entryKey: 'conversation' })}</>
}

const LAYOUT_CHILDREN = {
  'main': { kind: 'keyed', scope: 'root' },
} as const

async function bench(nodes: ToolResultNode[]) {
  const runtime = await SlotTestRuntime.create()
  new TestRemote(runtime.ctx, {
    session: {
      openWorkspacePath: vi.fn(async () => ({ ok: true, value: { opened: true } })),
    },
  })
  runtime.ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  runtime.ctx.provide('layout', { openDetails: vi.fn(), closeDetails: vi.fn() })
  runtime.ctx.provide('sidebarRight', { openResource: vi.fn() } as never)
  runtime.ctx.provide('uiWorkspace', {
    openWorkspace: vi.fn(async (_workspaceId: WorkspaceId, beforeOpen: (id: SessionId) => void) => {
      beforeOpen(SID)
      runtime.sessions.open(SID)
    }),
    openSession: (id: SessionId) => { runtime.sessions.open(id) },
  } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.sessions.add({
    id: SID,
    summary: { title: 'S', displayTitle: 'S', cwd: '/proj' },
    events: toolSessionEvents(nodes),
    session: {
      loadOlder: vi.fn<ISession['loadOlder']>(),
      prompt: vi.fn<ISession['prompt']>(async () => ({ ok: true, value: { accepted: true } })),
    },
  })
  await runtime.root.declare(LAYOUT_CHILDREN, AppRoot)
  await runtime.mount({ inject: [...injectConversation], apply: applyConversation })
  await runtime.mount({ inject: [...injectChat], apply: applyChat })
  await runtime.mount({ inject: [...injectTool], apply: applyTool })
  return runtime
}

describe('todo_write assembly (product registrations, no outlet twins)', () => {
  it('reaches the keyed toolview row and the dock plan strip, and the strip follows projection retirement', async () => {
    const runtime = await bench([todoResult(3)])
    // The dock strip reads the host-computed 'todos' projection.
    runtime.sessions.behavior(SID).projections.set('todos', TODOS)
    const view = runtime.renderRoot()

    // Keyed toolview registration took the row (summary derived from args).
    const row = view.container.querySelector('[data-tool="todo_write"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('1/3 已完成 · 实现 fixture 样本')

    // The plan strip sits in the input dock, fed by the projection
    // (default-collapsed: the header summary shows; rows appear on expand).
    const panel = view.container.querySelector('[data-testid="todo-panel"]')
    expect(panel).not.toBeNull()
    expect(panel!.textContent).toContain('1 已完成\u2002·\u20021 进行中\u2002·\u20021 待处理')
    fireEvent.click(panel!.querySelector('button')!)
    expect([...panel!.querySelectorAll('li')].map(li => li.getAttribute('data-status')))
      .toEqual(['completed', 'in_progress', 'pending'])

    // Next turn retires the standing plan (host pushes null): the strip
    // clears while the historical row stays in the flow.
    await runtime.flush()
    runtime.sessions.behavior(SID).projections.set('todos', null)
    await waitFor(() => {
      expect(view.container.querySelector('[data-testid="todo-panel"]')).toBeNull()
    })
    expect(view.container.querySelector('[data-tool="todo_write"]')).not.toBeNull()
    await runtime.dispose()
  })
})

describe('terminal card assembly', () => {
  it('both the keyed bash row and the fallback row reach the terminal card through the whole-row expand', async () => {
    const runtime = await bench([
      bashResult(3, 'c-keyed'),
      // pwsh has no package-local keyed row, so GenericToolCard owns its raw terminal card.
      bashResult(4, 'c-fallback', {
        call: { name: 'pwsh', argsRaw: '{"command":"ls -la","description":"List files"}' },
      }),
    ])
    const view = runtime.renderRoot()

    // Keyed BashRow: collapsed by default, the whole summary row is the toggle.
    const keyedRow = view.container.querySelector('[data-sample="bash"]')
    const keyed = keyedRow?.parentElement
    expect(keyed?.querySelector('[data-terminal]')).toBeNull()
    fireEvent.click(keyedRow!)
    await waitFor(() => {
      expect(keyed!.querySelector('[data-terminal]')).not.toBeNull()
    })

    // Fallback row: same unified expand interaction.
    const fallback = view.container.querySelector('[data-tool="pwsh"]')
    expect(fallback).not.toBeNull()
    expect(fallback!.querySelector('[data-terminal]')).toBeNull()
    fireEvent.click(fallback!.querySelector('[data-expandable]')!)
    await waitFor(() => {
      expect(fallback!.querySelector('[data-terminal]')).not.toBeNull()
    })
    await runtime.dispose()
  })
})
