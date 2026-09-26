// @vitest-environment jsdom
/** ToolCallTree-owned root/subcall markers and keyed Tool dispatch. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindDisclosure, useDisclosure } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/use-disclosure.ts'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ToolCallBlock, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { ToolCallOwnerProps, ToolTreeProps } from '../src/client/contract/slots.ts'
import { ToolCallTree } from '../src/client/tool/ToolCallTree.tsx'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'

afterEach(cleanup)

const t: ToolTreeProps['t'] = makeTranslate(zh, commonZh)

const root = (callId: string, call: ToolResultNode['call']): ToolResultNode => ({
  kind: 'tool-result', seq: 3, time: 3_000, callId, call, callTime: 2_000,
  content: [], isError: false, subCalls: [],
})

function props(
  block: ToolCallBlock,
  home?: string,
  owners?: ToolCallOwnerProps[],
): ToolTreeProps {
  const snapshot = {} as SessionSnapshot
  const useSession = ((selector: (value: SessionSnapshot) => unknown) => selector(snapshot)) as ToolTreeProps['useSession']
  const renderSlot = ((_key: string, owner: ToolCallOwnerProps, options?: { fallback?: React.ReactNode }) => {
    owners?.push(owner)
    return options?.fallback ?? null
  }) as unknown as ToolTreeProps['renderSlot']
  const fixture: Partial<ToolTreeProps> = {
    useDisclosure,
    useTurnData: () => undefined,
    useSession,
    renderSlot,
    node: {
      key: `tool:${block.callId}`,
      kind: 'tool-call',
      id: block.callId,
      target: 'chat',
      anchorSeq: 'seq' in block ? block.seq : 0,
      location: { kind: 'session' },
      visibility: 'visible',
      data: { root: block },
    },
    openFile: vi.fn(),
    openSkill: vi.fn(),
    renderMessageImages: () => null,
    inspectCall: vi.fn(),
    forkAt: vi.fn(),
    loadImage: vi.fn(() => Promise.reject(new Error('not used'))),
    fileMentions: vi.fn(),
    useHostInfo: ((selector: (info: { home: string | undefined }) => unknown) => selector({ home })) as ToolTreeProps['useHostInfo'],
    t,
  }
  return fixture as ToolTreeProps
}

describe('ToolCallTree', () => {
  it('dispatches only the parent and changed child among 100 sibling calls', () => {
    const children = Array.from({ length: 100 }, (_, index) => root(`child-${index}`, { name: 'custom_child', argsRaw: '{}' }))
    const block = { ...root('parent', { name: 'custom_parent', argsRaw: '{}' }), subCalls: children }
    const owners: ToolCallOwnerProps[] = []
    const initial = props(block, undefined, owners)
    const view = render(<ToolCallTree {...initial} />)
    expect(owners).toHaveLength(101)
    owners.length = 0
    const changed = { ...children[42]!, isError: true }
    const next = { ...block, subCalls: children.map((child, index) => index === 42 ? changed : child) }
    view.rerender(<ToolCallTree {...initial} node={{ ...initial.node, data: { root: next } }} />)
    expect(owners.map(owner => owner.callId)).toEqual(['parent', 'child-42'])
  })

  it('dispatches preparation through the existing keyed toolview with no argument fields', () => {
    const owners: ToolCallOwnerProps[] = []
    const view = render(<ToolCallTree {...props({
      phase: 'preparing', callId: 'preparing', name: 'write', turn: 1, step: 1, time: 1, subCalls: [],
    }, undefined, owners)} />)
    expect(owners[0]).toMatchObject({ phase: 'preparing', callId: 'preparing', toolName: 'write' })
    expect(owners[0]?.block).not.toHaveProperty('argsRaw')
    expect(view.container.querySelector('[data-chat-call-id="preparing"] [data-state="preparing"]')).not.toBeNull()
    expect(view.queryByRole('button')).toBeNull()
  })

  it('forwards one stable disclosure Hook to nested calls and resets only their open state', () => {
    const reset = createSnapshotStore(0)
    const useDisclosure = bindDisclosure(reset)
    const owners: ToolCallOwnerProps[] = []
    const block = {
      ...root('parent', { name: 'custom_parent', argsRaw: '{}' }),
      content: [{ type: 'text' as const, text: 'Parent output' }],
      subCalls: [{
        ...root('child', { name: 'custom_child', argsRaw: '{}' }),
        content: [{ type: 'text' as const, text: 'Child output' }],
      }],
    }
    const view = render(<ToolCallTree {...props(block, undefined, owners)} useDisclosure={useDisclosure} />)
    const rows = [...view.container.querySelectorAll<HTMLElement>('[data-expandable]')]
    expect(rows).toHaveLength(2)
    expect(owners.map(owner => owner.useDisclosure)).toEqual([useDisclosure, useDisclosure])
    const dispatched = [...owners]
    fireEvent.click(rows[0]!)
    fireEvent.click(rows[1]!)
    expect(view.getByText('Parent output')).toBeTruthy()
    expect(view.getByText('Child output')).toBeTruthy()

    act(() => { reset.set(1) })
    expect(view.queryByText('Parent output')).toBeNull()
    expect(view.queryByText('Child output')).toBeNull()
    expect([...view.container.querySelectorAll('[data-expandable]')]).toEqual(rows)
    expect(owners).toEqual(dispatched)
    fireEvent.click(rows[1]!)
    expect(view.getByText('Child output')).toBeTruthy()
    expect(view.queryByText('Parent output')).toBeNull()
  })

  it('owns the root marker and the generic fallback for a window-truncated call', () => {
    const block = root('w1', null)
    const view = render(<ToolCallTree {...props(block)} />)
    const row = view.container.querySelector('[data-chat-call-id="w1"]')
    expect(row?.getAttribute('data-chat-anchor-key')).toBe('call:w1')
    expect(view.container.querySelector('[data-variant="others"]')).not.toBeNull()
    expect(view.getByText('w1')).toBeTruthy()
  })

  it('renders a current-ID leaf under its historical-ID parent', () => {
    const owners: ToolCallOwnerProps[] = []
    const leaf = {
      ...root('unrelated:ptc:7', { name: 'read', argsRaw: '{"path":"a.ts"}' }),
      parentCallId: 'parent:code:1',
    }
    const child = {
      ...root('parent:code:1', { name: 'run_code', argsRaw: '{"code":"return 1"}' }),
      parentCallId: 'parent',
      subCalls: [leaf],
    }
    const block = {
      ...root('parent', { name: 'run_code', argsRaw: '{"code":"return 1"}' }),
      subCalls: [child],
    }
    const view = render(<ToolCallTree {...props(block, undefined, owners)} />)
    const nests = view.container.querySelectorAll('[data-subcalls]')
    expect(nests[0]?.parentElement).toBe(view.container.querySelector('[data-chat-call-id="parent"]'))
    expect(nests[1]?.parentElement).toBe(view.container.querySelector('[data-chat-call-id="parent:code:1"]'))
    expect(view.container.querySelector('[data-chat-call-id="unrelated:ptc:7"]')).not.toBeNull()
    expect(nests).toHaveLength(2)
    expect(owners.map(owner => [owner.callId, owner.block.parentCallId ?? null])).toEqual([
      ['parent', null],
      ['parent:code:1', 'parent'],
      ['unrelated:ptc:7', 'parent:code:1'],
    ])
  })

  it('omits Inspect from tool owners when the target view is unavailable', () => {
    const owners: ToolCallOwnerProps[] = []
    render(<ToolCallTree {...props(root('a', null), undefined, owners)} inspectCall={undefined} />)
    expect(owners[0]?.inspect).toBeUndefined()
  })

  it('dispatches a running call by its wire name and forwards inspect', () => {
    const owners: ToolCallOwnerProps[] = []
    const block: ToolCallBlock = {
      phase: 'start' as const, callId: 'running', name: 'bash', argsRaw: '{"command":"pwd"}',
      turn: 1, step: 0, time: 1_000, subCalls: [],
    }
    const treeProps = props(block, undefined, owners)
    render(<ToolCallTree {...treeProps} />)

    expect(owners[0]?.toolName).toBe('bash')
    expect(owners[0]?.phase).toBe('start')
    const inspect = owners[0]?.inspect
    expect(inspect).toBeDefined()
    inspect?.()
    expect(treeProps.inspectCall).toHaveBeenCalledExactlyOnceWith('running')
  })

  it('abbreviates a POSIX home path in the generic tool summary', () => {
    const block = root('w1', { name: 'read', argsRaw: '{"path":"/h/docs/a.ts"}' })
    const view = render(<ToolCallTree {...props(block, '/h')} />)
    expect(view.getByText('~/docs/a.ts')).toBeTruthy()
  })

  it('renders an Auto denial generically before keyed slot dispatch', () => {
    const block = {
      ...root('denied', { name: 'skill', argsRaw: '{"name":"deploy"}' }),
      isError: true,
      error: {
        name: 'AutoReviewDeniedError',
        code: 'AUTO_REVIEW_DENIED',
        reason: 'not authorized',
      },
    }
    const renderSlot = vi.fn(() => <div data-testid="keyed-skill" />)
    const view = render(<ToolCallTree {...props(block)} renderSlot={renderSlot as ToolTreeProps['renderSlot']} />)

    expect(renderSlot).not.toHaveBeenCalled()
    expect(view.queryByTestId('keyed-skill')).toBeNull()
    expect(view.getByText('Auto review 已拒绝')).toBeTruthy()
  })
})
