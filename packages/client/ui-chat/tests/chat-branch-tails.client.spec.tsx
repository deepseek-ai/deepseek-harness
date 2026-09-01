// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type {
  ChatConversationViewNode, ConversationNode,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ChatNodeViewProps } from '../src/client/contract/slots.ts'
import {
  formatMessageClock, msUntilNextLocalMidnight, startOfLocalDay,
} from '../src/client/chat/message-chrome.ts'
import {
  CompactionNodeView, ContextMessageNodeView, RetryNodeView, UnknownNodeView,
  UserMessageNodeView,
} from '../src/client/chat/MessageItem.tsx'
import { AssistantMarkdown, type AssistantMarkdownProps } from '../src/client/chat/AssistantMarkdown.tsx'
import { StatsLine } from '../src/client/chat/StatsLine.tsx'
import { zh } from '../src/client/locale.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'

/** jsdom has no ResizeObserver; StatsLine watches its row for ellipsis truncation through one. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => { vi.stubGlobal('ResizeObserver', ResizeObserverStub) })
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const t: ChatNodeViewProps['t'] = makeTranslate(zh, commonZh)
const renderMessageImages: AssistantMarkdownProps['renderMessageImages'] = () => null
const RETRY_ID = 'retry-fixture' as Extract<ConversationNode, { kind: 'model-retry' }>['retryId']

// Recency scans the whole transcript; a detached fixture is its own latest row.
const useDetachedChat: ChatNodeViewProps['useChat'] = bindSnapshotSelector({
  subscribe: () => () => {},
  getSnapshot: () => ({ order: [], nodes: new Map() }),
} as never)

interface MessageItemProps {
  readonly node: ConversationNode
  readonly t: ChatNodeViewProps['t']
  readonly referenceLabels?: readonly string[]
}

/** Legacy-node fixture adapter for the independently registered renderers. */
function MessageItem({ node, t: translate, referenceLabels }: MessageItemProps) {
  const kind = node.kind === 'assistant' ? 'assistant-step' : node.kind
  const viewNode: ChatConversationViewNode = {
    key: `fixture:${node.kind}:${node.seq}`,
    kind,
    id: String(node.seq),
    target: 'chat',
    anchorSeq: node.seq,
    location: { kind: 'session' },
    visibility: 'visible',
    data: node.kind === 'model-retry'
      ? { attempts: [node], current: node }
      : (node.kind === 'user' || node.kind === 'steering') && referenceLabels !== undefined
        ? { ...node, referenceLabels }
        : node,
  }
  const props = { node: viewNode, t: translate, renderMessageImages, useChat: useDetachedChat } as ChatNodeViewProps
  switch (node.kind) {
    case 'user':
    case 'steering':
      return <UserMessageNodeView {...props as ChatNodeViewProps<'user' | 'steering'>} />
    case 'context':
      return <ContextMessageNodeView {...props as ChatNodeViewProps<'context'>} />
    case 'compaction':
      return <CompactionNodeView {...props as ChatNodeViewProps<'compaction'>} />
    case 'model-retry':
      return <RetryNodeView {...props as ChatNodeViewProps<'model-retry'>} />
    case 'unknown':
      return <UnknownNodeView {...props as ChatNodeViewProps<'unknown'>} />
    default:
      throw new Error(`unsupported MessageItem fixture kind: ${node.kind}`)
  }
}

describe('MessageItem arms', () => {
  it('renders an adjacent session mention as a chip even without trailing whitespace', () => {
    const view = render(
      <MessageItem
        t={t}
        referenceLabels={['你好']}
        node={{
          kind: 'user',
          seq: 1,
          time: 1_000,
          content: [{ type: 'text', text: '@你好这个在讲啥' }] as never,
          source: null,
        }}
      />,
    )
    expect(view.container.querySelector('[data-ref-chip="session"]')?.textContent).toBe('你好')
    expect(view.container.querySelector('[data-ref-chip="session"] svg')).not.toBeNull()
    expect(view.getByText('这个在讲啥')).toBeTruthy()
    expect(view.getByText('引用会话 · 你好')).toBeTruthy()
  })

  it('renders the complete metadata-confirmed multi-word session label', () => {
    const view = render(
      <MessageItem
        t={t}
        referenceLabels={['Research notes']}
        node={{
          kind: 'user',
          seq: 1,
          time: 1_000,
          content: [{ type: 'text', text: '@Research notes what changed?' }] as never,
          source: null,
        }}
      />,
    )
    expect(view.container.querySelector('[data-ref-chip="session"]')?.textContent).toBe('Research notes')
    expect(view.getByText('what changed?')).toBeTruthy()
    expect(view.getByText('引用会话 · Research notes')).toBeTruthy()
  })

  it('renders no-extension paths as files and leaves sentence punctuation outside the reference', () => {
    const view = render(
      <MessageItem t={t} node={{
        kind: 'user',
        seq: 1,
        time: 1_000,
        content: [{ type: 'text', text: 'Read @Dockerfile and @src/README.md, please.' }] as never,
        source: null,
      }} />,
    )
    const files = [...view.container.querySelectorAll('[data-ref-chip="file"]')]
    expect(files.map(file => file.textContent)).toEqual(['Dockerfile', 'README.md'])
    expect(files.every(file => file.querySelector('svg') !== null)).toBe(true)
    expect(view.container.textContent).toContain('README.md, please.')
  })

  it('user bubbles expose clock / copy and neither branch nor edit; copy writes the text', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    // Same-day clock: construct "today at 14:24" so the label stays `HH:mm`.
    const now = new Date()
    const time = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 24).getTime()
    render(
      <MessageItem t={t} node={{
        kind: 'user', seq: 1, time,
        content: [{ type: 'text', text: 'hello bubble' }] as never,
        source: null,
      }}
      />,
    )
    expect(screen.getByText('14:24')).toBeTruthy()
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '在新对话中分支' })).toBeNull()
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(writeText).toHaveBeenCalledWith('hello bubble')
  })

  it('user copy falls back to execCommand when clipboard.writeText is unavailable', () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
    const exec = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: exec,
    })
    render(
      <MessageItem t={t} node={{
        kind: 'user', seq: 1, time: 1_000,
        content: [{ type: 'text', text: 'fallback body' }] as never,
        source: null,
      }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(exec).toHaveBeenCalledWith('copy')
  })

  it('user copy never claims success when the host rejects the write', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    render(
      <MessageItem t={t} node={{
        kind: 'user', seq: 1, time: 1_000,
        content: [{ type: 'text', text: 'quiet' }] as never,
        source: null,
      }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '复制成功' })).toBeNull()
  })

  it('copy swaps to the check success chrome, gates re-clicks, and reverts after a second', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(
      <MessageItem t={t} node={{
        kind: 'user', seq: 1, time: 1_000,
        content: [{ type: 'text', text: 'copied body' }] as never,
        source: null,
      }}
      />,
    )
    const copy = screen.getByRole('button', { name: '复制' })
    fireEvent.click(copy)
    fireEvent.click(copy)
    expect(writeText).toHaveBeenCalledTimes(1)
    // Two microtask ticks: writeClipboard's own await, then the .then that
    // lands the success chrome.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    const done = screen.getByRole('button', { name: '复制成功' })
    fireEvent.click(done)
    expect(writeText).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
  })

  it('clears copy feedback work when the message unmounts', async () => {
    vi.useFakeTimers()
    let finishWrite!: () => void
    const writeText = vi.fn(() => new Promise<void>((resolve) => { finishWrite = resolve }))
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const view = render(
      <MessageItem t={t} node={{
        kind: 'user', seq: 1, time: 1_000,
        content: [{ type: 'text', text: 'copied body' }] as never,
        source: null,
      }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    view.unmount()
    await act(async () => {
      finishWrite()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(vi.getTimerCount()).toBe(0)

    const mounted = render(
      <MessageItem t={t} node={{
        kind: 'user', seq: 2, time: 1_000,
        content: [{ type: 'text', text: 'copied body' }] as never,
        source: null,
      }}
      />,
    )
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: '复制成功' })).toBeTruthy()
    mounted.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('consumed steering renders as a plain user bubble and keeps copy without branch', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const view = render(
      <MessageItem t={t} node={{
        kind: 'steering', messageId: 'steer-message', seq: 2, time: 1_000, turn: 1, source: null,
        content: [{ type: 'text', text: 'steer!' }, { type: 'image', data: 'x' }] as never,
      } as never}
      />,
    )
    expect(view.queryByText('插话')).toBeNull()
    expect(view.getByText('steer!')).toBeTruthy()
    expect(view.getByText(/附加内容块/)).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '复制' }))
    expect(writeText).toHaveBeenCalledWith('steer!')
    expect(view.queryByRole('button', { name: '在新对话中分支' })).toBeNull()
  })

  it('context uses the Tool calls disclosure chrome and keeps its body collapsed by default', () => {
    const ctxView = render(
      <MessageItem t={t} node={{
        kind: 'context',
        seq: 3,
        content: [{ type: 'text', text: 'line one\n\nline two' }],
        source: { kind: 'plugin', plugin: 'fixture', empty: {}, list: [] },
        provenance: { role: 'inject', label: 'fixture' },
        form: null,
      } as never}
      />,
    )
    const disclosure = ctxView.getByRole('button', { name: /^上下文注入\s*fixture$/ })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(ctxView.container.querySelector('[data-context-injection-body]')).toBeNull()
    expect(ctxView.container.querySelector('svg')).not.toBeNull()
    expect(ctxView.container.querySelector('[data-context-recall-icon]')).toBeNull()

    fireEvent.click(disclosure)
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    // An unknown form renders the opaque body: the model-facing text keeps its
    // real line breaks instead of being escaped into one JSON line, and the
    // remaining source data follows it as fields.
    expect(ctxView.container.querySelector('[data-context-text]')?.textContent)
      .toBe('line one\n\nline two')
    const fields = [...ctxView.container.querySelectorAll('[data-context-fields] dt')].map(node => node.textContent)
    expect(fields).toEqual(['plugin', 'empty', 'list'])

    fireEvent.keyDown(disclosure, { key: ' ' })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
  })

  it('the instructions form names the files it reconciled above their text', () => {
    const view = render(
      <MessageItem t={t} node={{
        kind: 'context',
        seq: 3,
        content: [{ type: 'text', text: '<system-reminder>\nInstructions from: AGENTS.md\n</system-reminder>' }],
        source: {
          kind: 'agent-instructions',
          form: 'instructions',
          baseline: true,
          changes: [
            { action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: 'abc' },
            { action: 'remove', scope: 'sub\u0000AGENTS.md', path: 'sub/AGENTS.md' },
            { action: 'replace', scope: '.\u0000AGENTS.md', path: 'AGENTS.md' },
          ],
        },
        provenance: { role: 'inject', label: 'AGENTS.md, sub/AGENTS.md' },
        form: 'instructions',
      } as never}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: /^上下文注入\s*AGENTS\.md, sub\/AGENTS\.md$/ }))
    const files = [...view.container.querySelectorAll('[data-context-files] li')].map(node => node.textContent)
    expect(files).toEqual(['AGENTS.md已载入', 'sub/AGENTS.md已移除'])
    // The `<system-reminder>` framing is part of what the model read, so the
    // body keeps it verbatim rather than presenting a cleaned-up excerpt.
    expect(view.container.querySelector('[data-context-text]')?.textContent)
      .toContain('<system-reminder>')
  })

  it('a delta distinguishes a newly reconciled file from a rewritten one', () => {
    const view = render(
      <MessageItem t={t} node={{
        kind: 'context',
        seq: 3,
        content: [{ type: 'text', text: 'delta' }],
        source: {
          kind: 'agent-instructions',
          form: 'instructions',
          changes: [
            { action: 'set', scope: 'a', path: 'new/AGENTS.md' },
            { action: 'replace', scope: 'b', path: 'old/AGENTS.md' },
          ],
        },
        provenance: { role: 'inject', label: 'new/AGENTS.md, old/AGENTS.md' },
        form: 'instructions',
      } as never}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: /^上下文注入\s*new\/AGENTS\.md, old\/AGENTS\.md$/ }))
    const files = [...view.container.querySelectorAll('[data-context-files] li')].map(node => node.textContent)
    expect(files).toEqual(['new/AGENTS.md已新增', 'old/AGENTS.md已更新'])
  })

  it('keeps an interleaved unknown block in the order the model received it', () => {
    const view = render(
      <MessageItem t={t} node={{
        kind: 'context',
        seq: 3,
        content: [
          { type: 'text', text: 'before' },
          { type: 'future-block', payload: 1 },
          { type: 'text', text: 'after' },
        ],
        source: null,
        provenance: { role: 'inject', label: null },
        form: null,
      } as never}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: '上下文注入' }))
    const texts = [...view.container.querySelectorAll('[data-context-text]')].map(node => node.textContent)
    expect(texts).toEqual(['before', 'after'])
    expect(view.getByText(/未知内容块/)).toBeTruthy()
  })

  it('the catalog form lists its durable entries instead of the model-facing prose', () => {
    const view = render(
      <MessageItem t={t} node={{
        kind: 'context',
        seq: 3,
        content: [{ type: 'text', text: '<system-reminder>\n<available_skills>\n- `a`: A\n</available_skills>' }],
        source: {
          kind: 'skill-catalog',
          form: 'catalog',
          entries: [{ name: 'a-skill', description: 'Does A' }, { name: 'b-skill', description: 'Does B' }],
        },
        provenance: { role: 'inject', label: 'skill-catalog' },
        form: 'catalog',
      } as never}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: /^上下文注入\s*skill-catalog$/ }))
    const entries = [...view.container.querySelectorAll('[data-context-entries] li')].map(node => node.textContent)
    expect(entries).toEqual(['a-skillDoes A', 'b-skillDoes B'])
    expect(view.container.querySelector('[data-context-text]')).toBeNull()
    expect(view.container.querySelector('[data-context-catalog-update]')).toBeNull()
  })

  it('a replacement catalog says so above its entries', () => {
    const view = render(
      <MessageItem t={t} node={{
        kind: 'context',
        seq: 3,
        content: [{ type: 'text', text: 'catalog prose' }],
        source: {
          kind: 'skill-catalog',
          form: 'catalog',
          update: true,
          entries: [{ name: 'a-skill', description: 'Does A' }],
        },
        provenance: { role: 'inject', label: 'skill-catalog' },
        form: 'catalog',
      } as never}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: /^上下文注入\s*skill-catalog$/ }))
    expect(view.container.querySelector('[data-context-catalog-update]')?.textContent).toBe('替换目录')
  })

  it('a partially unreadable catalog falls back whole rather than showing a short list', () => {
    // All-or-nothing: a body that replaces the model-facing text must not show
    // a confident, incomplete account of what the model read.
    const view = render(
      <MessageItem t={t} node={{
        kind: 'context',
        seq: 3,
        content: [{ type: 'text', text: 'catalog prose' }],
        source: {
          kind: 'skill-catalog',
          form: 'catalog',
          entries: [{ name: 'a-skill', description: 'Does A' }, { name: 'b-skill' }],
        },
        provenance: { role: 'inject', label: 'skill-catalog' },
        form: 'catalog',
      } as never}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: /^上下文注入\s*skill-catalog$/ }))
    expect(view.container.querySelector('[data-context-entries]')).toBeNull()
    expect(view.container.querySelector('[data-context-text]')?.textContent).toBe('catalog prose')
    // The marker reports what rendered, not what was declared.
    expect(view.container.querySelector('[data-context-injection-body]')?.getAttribute('data-context-form'))
      .toBeNull()
  })

  it('an unreadable instruction list falls back to the opaque body with its fields', () => {
    const view = render(
      <MessageItem t={t} node={{
        kind: 'context',
        seq: 3,
        content: [{ type: 'text', text: 'instruction prose' }],
        source: { kind: 'agent-instructions', form: 'instructions', changes: [{ action: 'set' }] },
        provenance: { role: 'inject', label: 'agent-instructions' },
        form: 'instructions',
      } as never}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: /^上下文注入\s*agent-instructions$/ }))
    expect(view.container.querySelector('[data-context-files]')).toBeNull()
    expect(view.container.querySelector('[data-context-text]')?.textContent).toBe('instruction prose')
    expect(view.container.querySelector('[data-context-fields]')).not.toBeNull()
  })

  it('joins adjacent text blocks the way a provider adapter flattens them', () => {
    // No invented separator: showing a line break the model never saw would
    // misreport the request.
    const view = render(
      <MessageItem t={t} node={{
        kind: 'context',
        seq: 3,
        content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }],
        source: null,
        provenance: { role: 'inject', label: null },
        form: null,
      } as never}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: '上下文注入' }))
    expect(view.container.querySelector('[data-context-text]')?.textContent).toBe('firstsecond')
  })

  it('bounds an oversized source field, not only the model-facing text', () => {
    const view = render(
      <MessageItem t={t} node={{
        kind: 'context',
        seq: 3,
        content: [{ type: 'text', text: 'short' }],
        source: { kind: 'plugin', note: 'y'.repeat(21_000) },
        provenance: { role: 'inject', label: 'plugin' },
        form: null,
      } as never}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: /^上下文注入\s*plugin$/ }))
    expect(view.container.querySelector('[data-context-fields] dd')?.textContent)
      .toMatch(/… 已截断，共 \d+ 字符$/)
  })

  it('an empty replacement catalog stays a catalog: it retires every earlier name', () => {
    // `renderCatalogUpdate` legitimately publishes zero entries when the last
    // skill disappears; falling back would hide that the catalog was cleared.
    const view = render(
      <MessageItem t={t} node={{
        kind: 'context',
        seq: 3,
        content: [{ type: 'text', text: 'catalog prose' }],
        source: { kind: 'skill-catalog', form: 'catalog', update: true, entries: [] },
        provenance: { role: 'inject', label: 'skill-catalog' },
        form: 'catalog',
      } as never}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: /^上下文注入\s*skill-catalog$/ }))
    expect(view.container.querySelector('[data-context-catalog-update]')?.textContent).toBe('替换目录')
    expect(view.container.querySelectorAll('[data-context-entries] li')).toHaveLength(0)
    expect(view.container.querySelector('[data-context-injection-body]')?.getAttribute('data-context-form'))
      .toBe('catalog')
  })

  it('a catalog whose entries are unreadable falls back to the opaque body', () => {
    const view = render(
      <MessageItem t={t} node={{
        kind: 'context',
        seq: 3,
        content: [{ type: 'text', text: 'catalog prose' }],
        source: { kind: 'skill-catalog', form: 'catalog', entries: 'not-a-list' },
        provenance: { role: 'inject', label: 'skill-catalog' },
        form: 'catalog',
      } as never}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: /^上下文注入\s*skill-catalog$/ }))
    expect(view.container.querySelector('[data-context-entries]')).toBeNull()
    expect(view.container.querySelector('[data-context-text]')?.textContent).toBe('catalog prose')
  })

  it('bounds a large catalog and says how many rows it withheld', () => {
    const entries = Array.from({ length: 205 }, (_, index) => ({ name: `s-${index}`, description: 'd' }))
    const view = render(
      <MessageItem t={t} node={{
        kind: 'context', seq: 3, content: [{ type: 'text', text: 'catalog prose' }],
        source: { kind: 'skill-catalog', form: 'catalog', entries },
        provenance: { role: 'inject', label: 'skill-catalog' },
        form: 'catalog',
      } as never}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: /^上下文注入\s*skill-catalog$/ }))
    expect(view.container.querySelectorAll('[data-context-entries] li')).toHaveLength(200)
    expect(view.container.querySelector('[data-context-entries-truncated]')?.textContent).toBe('…还有 5 条')
  })

  it('a catalog keeps a content block this version does not know', () => {
    const view = render(
      <MessageItem t={t} node={{
        kind: 'context',
        seq: 3,
        content: [{ type: 'text', text: 'prose' }, { type: 'future-block', payload: 1 }],
        source: { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'a', description: 'b' }] },
        provenance: { role: 'inject', label: 'skill-catalog' },
        form: 'catalog',
      } as never}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: /^上下文注入\s*skill-catalog$/ }))
    expect(view.getByText(/未知内容块/)).toBeTruthy()
  })

  it('an instruction change with an unrecognized action falls back whole', () => {
    // The action decides the word the row shows, so an unknown one cannot be
    // presented as loaded or updated.
    const view = render(
      <MessageItem t={t} node={{
        kind: 'context',
        seq: 3,
        content: [{ type: 'text', text: 'instruction prose' }],
        source: { kind: 'agent-instructions', form: 'instructions', changes: [{ action: 'merge', path: 'A.md' }] },
        provenance: { role: 'inject', label: 'agent-instructions' },
        form: 'instructions',
      } as never}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: /^上下文注入\s*agent-instructions$/ }))
    expect(view.container.querySelector('[data-context-files]')).toBeNull()
    expect(view.container.querySelector('[data-context-text]')?.textContent).toBe('instruction prose')
  })

  it('the opaque fallback keeps a form declaration this version cannot present', () => {
    // Otherwise a newer or foreign log's declared shape vanishes from the UI.
    const view = render(
      <MessageItem t={t} node={{
        kind: 'context', seq: 3, content: [{ type: 'text', text: 'x' }],
        source: { kind: 'plugin', plugin: 'later', form: 'a-later-form' },
        provenance: { role: 'inject', label: 'later' },
        form: null,
      } as never}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: /^上下文注入\s*later$/ }))
    const fields = [...view.container.querySelectorAll('[data-context-fields] dt')].map(node => node.textContent)
    expect(fields).toEqual(['plugin', 'form'])
  })

  it('the snapshot form attributes each part to the subsystem that produced it', () => {
    const view = render(
      <MessageItem t={t} node={{
        kind: 'context',
        seq: 3,
        content: [{ type: 'text', text: 'Current runtime context.\n\nsandbox\n\nworkspace' }],
        source: {
          kind: 'plugin',
          plugin: '@deepseek-ai/dsh-system-prompt',
          form: 'snapshot',
          sections: [{ name: 'sandbox:policy', text: 'workspace-write' }, { name: 'workspace', text: '/repo' }],
        },
        provenance: { role: 'inject', label: '@deepseek-ai/dsh-system-prompt' },
        form: 'snapshot',
      } as never}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: /^上下文注入\s*@deepseek-ai\/dsh-system-prompt$/ }))
    const rows = [...view.container.querySelectorAll('[data-context-sections] div')].map(node => node.textContent)
    expect(rows).toEqual(['sandbox:policyworkspace-write', 'workspace/repo'])
  })

  it('a notice puts its account on the collapsed row', () => {
    // The whole point of the form: readable without expanding.
    const view = render(
      <MessageItem t={t} node={{
        kind: 'context',
        seq: 3,
        content: [{ type: 'text', text: 'background job bash-1 finished.' }],
        source: { kind: 'plugin', plugin: 'tool-jobs', form: 'notice', summary: 'bash pnpm test [status: completed]' },
        provenance: { role: 'inject', label: 'tool-jobs' },
        form: 'notice',
      } as never}
      />,
    )
    expect(view.container.querySelector('[data-context-summary]')?.textContent)
      .toBe('bash pnpm test [status: completed]')
    expect(view.container.querySelector('[data-context-injection-body]')).toBeNull()
  })

  it('a notice without its account falls back to the opaque body', () => {
    const view = render(
      <MessageItem t={t} node={{
        kind: 'context', seq: 3, content: [{ type: 'text', text: 'notice prose' }],
        source: { kind: 'plugin', plugin: 'tool-jobs', form: 'notice' },
        provenance: { role: 'inject', label: 'tool-jobs' },
        form: 'notice',
      } as never}
      />,
    )
    expect(view.container.querySelector('[data-context-summary]')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: /^上下文注入\s*tool-jobs$/ }))
    expect(view.container.querySelector('[data-context-fields]')).not.toBeNull()
  })

  it('each form falls back to the opaque body when its required facts are unreadable', () => {
    // The fallback chain is the load-bearing wall: every dedicated form must
    // reach it, and the row marker must not claim a form that did not render.
    const cases = [
      { form: 'snapshot', source: { kind: 'plugin', form: 'snapshot', sections: 'not-a-list' }, label: 'plugin' },
      { form: 'relay', source: { kind: 'agent-message', form: 'relay' }, label: 'agent-message' },
      { form: 'recall', source: { kind: 'session-reference', form: 'recall', references: [{ label: 'x' }] }, label: 'session-reference' },
    ] as const
    for (const { form, source, label } of cases) {
      cleanup()
      const view = render(
        <MessageItem t={t} node={{
          kind: 'context', seq: 3, content: [{ type: 'text', text: `${form} prose` }],
          source, provenance: { role: 'inject', label }, form,
        } as never}
        />,
      )
      fireEvent.click(view.getByRole('button', { name: new RegExp(`^上下文注入\\s*${label}$`) }))
      expect(view.container.querySelector('[data-context-text]')?.textContent).toBe(`${form} prose`)
      expect(view.container.querySelector('[data-context-injection-body]')?.getAttribute('data-context-form'))
        .toBeNull()
    }
  })

  it('a snapshot states the supersession its framing line carries', () => {
    const view = render(
      <MessageItem t={t} node={{
        kind: 'context', seq: 3, content: [{ type: 'text', text: 'Current runtime context.' }],
        source: { kind: 'plugin', form: 'snapshot', sections: [{ name: 'sandbox', text: 'w' }] },
        provenance: { role: 'inject', label: 'plugin' },
        form: 'snapshot',
      } as never}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: /^上下文注入\s*plugin$/ }))
    expect(view.container.querySelector('[data-context-snapshot-supersedes]')?.textContent)
      .toBe('取代先前的快照')
  })

  it('a relay names the agent that sent it above what it said', () => {
    const view = render(
      <MessageItem t={t} node={{
        kind: 'context',
        seq: 3,
        content: [{ type: 'text', text: 'child report body' }],
        source: { kind: 'agent-message', form: 'relay', senderSessionId: 'child-7' },
        provenance: { role: 'inject', label: 'agent-message' },
        form: 'relay',
      } as never}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: /^上下文注入\s*agent-message$/ }))
    expect(view.container.querySelector('[data-context-relay-sender]')?.textContent).toBe('来自会话 child-7')
    expect(view.container.querySelector('[data-context-text]')?.textContent).toBe('child report body')
  })

  it('a recall reports how much of each source session survived the read', () => {
    // Recalled context is bounded on the way in, so hiding the omitted count
    // would overstate what the model received.
    const view = render(
      <MessageItem t={t} node={{
        kind: 'context',
        seq: 3,
        content: [{ type: 'text', text: 'recalled material' }],
        source: {
          kind: 'session-reference',
          form: 'recall',
          version: 1,
          references: [
            { label: '重构 loader', retainedMessages: 18, omittedMessages: 42, truncated: true },
            { label: '修 CI', retainedMessages: 3, omittedMessages: 0, truncated: false },
          ],
        },
        provenance: { role: 'recall', label: '重构 loader, 修 CI' },
        form: 'recall',
      } as never}
      />,
    )
    expect(view.container.querySelector('[data-context-recall-icon]')).not.toBeNull()
    fireEvent.click(view.getByRole('button', { name: /^跨会话召回\s*重构 loader, 修 CI$/ }))
    const rows = [...view.container.querySelectorAll('[data-context-recalls] li')].map(node => node.textContent)
    expect(rows).toEqual(['重构 loader保留 18 条 · 省略 42 条已截断', '修 CI保留 3 条 · 省略 0 条'])
    expect(view.container.querySelector('[data-context-text]')?.textContent).toBe('recalled material')
  })

  it('unknown nodes retain the generic JSON row', () => {
    const unknownView = render(
      <MessageItem t={t} node={{ kind: 'unknown', seq: 4, type: 'surface/next', data: { x: 1 } } as never} />,
    )
    expect(unknownView.getByText(/未知 surface 事件：surface\/next/)).toBeTruthy()
  })

  it('a compaction marker discloses its summary and never shows the framed checkpoint', () => {
    const view = render(
      <MessageItem t={t} node={{
        kind: 'compaction', seq: 5, time: 1_000,
        summary: '## 摘要标题\n\n保留的事实。',
        summaryEventSeq: 4,
        shadowedItemCount: 16,
        shadowedTokenCount: 11_309,
      }}
      />,
    )
    const row = view.getByRole('button', { name: /上下文已压缩/ })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(view.getByText('已压缩 16 条历史记录（约 11309 tokens）')).toBeTruthy()
    expect(view.queryByText(/保留的事实/)).toBeNull()
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByRole('heading', { name: '摘要标题' })).toBeTruthy()
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })

  it('a marker whose cited summary event fell outside the window is not expandable', () => {
    const view = render(<MessageItem t={t} node={{
      kind: 'compaction', seq: 6, time: 1_000, summary: null,
      summaryEventSeq: null, shadowedItemCount: null, shadowedTokenCount: null,
    }} />)
    const row = view.getByRole('button', { name: /上下文已压缩/ })
    expect(row).toHaveProperty('disabled', true)
    expect(row.getAttribute('aria-expanded')).toBeNull()
    expect(view.getByText('压缩摘要不可用')).toBeTruthy()
    fireEvent.click(row) // a disabled control stays collapsed
    expect(row.getAttribute('aria-expanded')).toBeNull()
  })

  it('collapses retry details behind the durable model retry status', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const view = render(
      <MessageItem
        t={t}
        node={{
          kind: 'model-retry',
          retryId: RETRY_ID,
          seq: 5,
          time: 10_000,
          retryState: 'scheduled',
          turn: 1,
          step: 0,
          provider: 'mock',
          mode: 'normal',
          policyKey: 'mock-normal',
          retry: 1,
          maxRetries: 2,
          delayMs: 2_500.4,
          failure: { code: 'TRANSPORT', message: '连接被重置' },
        }}
      />,
    )
    const details = view.container.querySelector('details')
    const summary = view.container.querySelector('summary')
    expect(details?.open).toBe(false)
    expect(details?.dataset.active).toBe('true')
    expect(view.getByRole('status').textContent).toBe('正在重试模型请求（1/2） · 3s')
    expect(view.getByText('重试延迟：').parentElement?.textContent).toBe('重试延迟：2500毫秒')
    expect(view.getByText('失败原因：').parentElement?.textContent).toBe('失败原因：连接被重置')

    act(() => { vi.advanceTimersByTime(1_100) })
    expect(view.getByRole('status').textContent).toBe('正在重试模型请求（1/2） · 2s')
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(view.getByRole('status').textContent).toBe('正在重试模型请求（1/2） · 1s')

    view.rerender(
      <MessageItem
        t={t}
        node={{
          kind: 'model-retry',
          retryId: RETRY_ID,
          seq: 6,
          time: 12_100,
          retryState: 'scheduled',
          turn: 2,
          step: 0,
          provider: 'mock',
          mode: 'normal',
          policyKey: 'mock-normal',
          retry: 2,
          maxRetries: 2,
          delayMs: 3_500.4,
          failure: { code: 'TRANSPORT', message: '再次断开' },
        }}
      />,
    )
    expect(view.getByRole('status').textContent).toBe('正在重试模型请求（2/2） · 4s')

    if (summary === null) throw new Error('retry summary missing')
    fireEvent.click(summary)
    expect(details?.open).toBe(true)

    view.rerender(
      <MessageItem t={t} node={{
        kind: 'model-retry',
        retryId: RETRY_ID,
        seq: 6,
        time: 12_100,
        retryState: 'started',
        turn: 2,
        step: 0,
        provider: 'mock',
        mode: 'normal',
        policyKey: 'mock-normal',
        retry: 2,
        maxRetries: 2,
        delayMs: 3_500.4,
        failure: { code: 'TRANSPORT', message: '再次断开' },
      }}
      />,
    )
    expect(details?.dataset.active).toBeUndefined()
    expect(view.getByRole('status').textContent).toBe('已重试模型请求（2/2） · 4s')

    view.rerender(
      <MessageItem t={t} node={{
        kind: 'model-retry',
        retryId: RETRY_ID,
        seq: 7,
        time: 12_100,
        retryState: 'started',
        turn: 3,
        step: 0,
        provider: 'mock',
        mode: 'always',
        policyKey: 'mock-always',
        retry: 3,
        delayMs: 3_500.4,
        failure: { code: 'TRANSPORT', message: '继续重试' },
      }}
      />,
    )
    expect(view.getByRole('status').textContent).toBe('已重试模型请求（3/∞） · 4s')

    view.rerender(
      <MessageItem t={t} node={{
        kind: 'model-retry',
        retryId: RETRY_ID,
        seq: 8,
        time: 12_100,
        retryState: 'cancelled',
        turn: 4,
        step: 0,
        provider: 'mock',
        mode: 'normal',
        policyKey: 'mock-normal',
        retry: 1,
        maxRetries: 2,
        delayMs: 3_500.4,
        failure: { code: 'TRANSPORT', message: '用户取消' },
      }}
      />,
    )
    expect(view.getByRole('status').textContent).toBe('模型请求重试已取消（1/2） · 4s')
  })

})

describe('formatMessageClock', () => {
  const now = new Date(2026, 6, 29, 10, 0).getTime()

  it('keeps HH:mm on the same calendar day', () => {
    expect(formatMessageClock(new Date(2026, 6, 29, 14, 24).getTime(), t, now)).toBe('14:24')
  })

  it('prefixes month and day across days in the same year', () => {
    expect(formatMessageClock(new Date(2026, 0, 1, 14, 24).getTime(), t, now)).toBe('1月1日 14:24')
  })

  it('prefixes year, month, and day across years', () => {
    expect(formatMessageClock(new Date(2025, 11, 31, 9, 5).getTime(), t, now)).toBe('2025年12月31日 09:05')
  })

  it('arms the next local midnight from an in-day instant', () => {
    const noon = new Date(2026, 6, 29, 12, 0).getTime()
    expect(startOfLocalDay(noon)).toBe(new Date(2026, 6, 29).getTime())
    expect(msUntilNextLocalMidnight(noon)).toBe(12 * 3_600_000)
  })
})

describe('useCalendarDay boundary refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('widens a same-day user clock after local midnight', () => {
    const dayStart = new Date(2026, 6, 29, 23, 50).getTime()
    vi.setSystemTime(dayStart)
    const time = new Date(2026, 6, 29, 14, 24).getTime()
    render(
      <MessageItem t={t} node={{
        kind: 'user', seq: 1, time,
        content: [{ type: 'text', text: 'night bubble' }] as never,
        source: null,
      }}
      />,
    )
    expect(screen.getByText('14:24')).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(msUntilNextLocalMidnight(dayStart) + 1)
    })
    expect(screen.getByText('7月29日 14:24')).toBeTruthy()
  })
})

describe('small branch tails', () => {
  it('AssistantMarkdown single-line reasoning summary skips the newline cut', () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'one-liner' }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByText('one-liner')).toBeTruthy()
  })

  it('StatsLine omits the cache-hit segment when no input accounting exists at all', () => {
    // Cache hit is null only when all three prompt buckets are zero (pure
    // output accounting) — any billed input makes it a real 0%.
    const nodes = [{
      kind: 'assistant', seq: 1, time: 1_000, turn: 1, step: 1, blocks: [], usage: { outputTokens: 10 },
    }] as const
    const snap = chatSnapshotFixture({ nodes })
    const source = { getSnapshot: () => snap, subscribe: () => () => {} }
    const view = render(
      <StatsLine
        t={t}
        useChat={bindSnapshotSelector(source)}
        useProjection={(key: string) => key === 'tokenUsage'
          ? { uncachedInputTokens: 0, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }
          : undefined}
      />,
    )
    expect(view.container.textContent).toBe('1 轮 · 1 步| 输入 0 tok · 输出 10 tok')
  })
})
