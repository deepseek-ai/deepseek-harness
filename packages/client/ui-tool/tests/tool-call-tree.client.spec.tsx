// @vitest-environment jsdom
/** ToolCallTree-owned root/subcall markers and selection projection. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
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
  selectedCallId?: string,
  home?: string,
  owners?: ToolCallOwnerProps[],
): ToolTreeProps {
  const snapshot = {} as SessionSnapshot
  const useSession = ((selector: (value: SessionSnapshot) => unknown) => selector(snapshot)) as ToolTreeProps['useSession']
  const renderSlot = ((_key: string, owner: ToolCallOwnerProps, options?: { fallback?: React.ReactNode }) => {
    owners?.push(owner)
    return options?.fallback ?? null
  }) as unknown as ToolTreeProps['renderSlot']
  return {
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
    selectedCallId,
    openFile: vi.fn(),
    inspectCall: vi.fn(),
    forkAt: vi.fn(),
    loadImage: vi.fn(() => Promise.reject(new Error('not used'))),
    fileMentions: vi.fn(),
    useHostInfo: ((selector: (info: { home: string | undefined }) => unknown) => selector({ home })) as ToolTreeProps['useHostInfo'],
    t,
  } as unknown as ToolTreeProps
}

describe('ToolCallTree', () => {
  it('owns the root marker and the generic fallback for a window-truncated call', () => {
    const block = root('w1', null)
    const view = render(<ToolCallTree {...props(block, 'w1')} />)
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
    const view = render(<ToolCallTree {...props(block, leaf.callId, undefined, owners)} />)
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

  it('dispatches a running call by its wire name and forwards inspect', () => {
    const owners: ToolCallOwnerProps[] = []
    const block: ToolCallBlock = {
      callId: 'running', name: 'bash', argsRaw: '{"command":"pwd"}',
      turn: 1, step: 0, time: 1_000, subCalls: [],
    }
    const treeProps = props(block, undefined, undefined, owners)
    render(<ToolCallTree {...treeProps} />)

    expect(owners[0]?.toolName).toBe('bash')
    const inspect = owners[0]?.inspect
    expect(inspect).toBeDefined()
    inspect?.()
    expect(treeProps.inspectCall).toHaveBeenCalledExactlyOnceWith('running')
  })

  it('abbreviates a POSIX home path in the generic tool summary', () => {
    const block = root('w1', { name: 'read', argsRaw: '{"path":"/h/docs/a.ts"}' })
    const view = render(<ToolCallTree {...props(block, 'w1', '/h')} />)
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
