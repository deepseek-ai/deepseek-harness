// @vitest-environment jsdom
/**
 * QueueDock rendering and operations: authoritative rows, inline editing,
 * collapse state, removal, strict steering, failure notices, and live retirement.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type {
  QueuedMessage, SessionListState, SessionSnapshot,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  bindSnapshotSelector, conversationSnapshot, makeTranslate,
} from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionPendingInteractionSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { QueueItemId } from '../src/client/contract/queue.ts'
import type { InputState } from '../src/client/contract/input.ts'
import { zh } from '../src/client/locales.ts'
import { QueueDock, queueDockEntry, type QueueDockInjected, type QueueDockProps } from '../src/client/queue/QueueDock.tsx'

afterEach(cleanup)

const SID = 's1' as SessionId
const iid = (id: string): QueueItemId => id as QueueItemId

function row(id: string, text: string | null, preview = text ?? '[image]'): QueuedMessage {
  return {
    id: iid(id), messageId: `message-${id}` as never, placement: 'queued',
    content: text === null ? [{ type: 'image', data: 'x' } as never] : [{ type: 'text', text }],
    preview, text,
  }
}

function snapshotWith(queue: QueuedMessage[]): SessionSnapshot {
  return {
    sessionId: SID, queue, running: true, removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, blank: false, subagent: null,
    pendingSubmissions: [],
    lastAgentError: null, promptAttempted: true, awaitingFirstTurn: false,
  }
}

/** Minimal live source backing the useSession stub. */
function liveSession(initial: SessionSnapshot) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  const useSession: SnapshotSelectorHook<SessionSnapshot> = selector =>
    useSyncExternalStore(
      (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      () => selector(snapshot),
    )
  return {
    useSession,
    push(next: SessionSnapshot): void {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

const INPUT_STATE: InputState = { draft: '', attachmentIds: [], draftRev: 0, phase: 'plain', occurrences: [], queue: [] }

const t: QueueDockProps['t'] = makeTranslate(zh, commonZh)

function kitFor(snapshot: SessionSnapshot, injected: Partial<QueueDockInjected> = {}) {
  return {
    sessionId: SID,
    t,
    useSessions: (() => { throw new Error('unused') }) as unknown as SnapshotSelectorHook<SessionListState>,
    useSessionPendingInteraction: bindSnapshotSelector(
      createSnapshotStore<SessionPendingInteractionSnapshot>(new Map()),
    ),
    useWorkspaces: (() => { throw new Error('unused') }) as never,
    useProjection: (() => undefined) as never,
    useConversation: bindSnapshotSelector(createSnapshotStore(conversationSnapshot())),
    useChat: (() => { throw new Error('unused') }) as QueueDockProps['useChat'],
    useTrajectory: (() => { throw new Error('unused') }) as QueueDockProps['useTrajectory'],
    useInput: (() => { throw new Error('unused') }) as never,
    inputActions: { setDraft: () => {}, submit: () => {} } as never,
    session: snapshot,
    input: INPUT_STATE,
    updateQueue: vi.fn(() => Promise.resolve()),
    notify: vi.fn(),
    loadImage: vi.fn(() => Promise.resolve('blob:unused')),
    ...injected,
  }
}

/** One queued row carrying a durable image reference (plus optional leading text). */
function imageRow(id: string, refId: string, text = ''): QueuedMessage {
  return {
    id: iid(id), messageId: `message-${id}` as never, placement: 'queued',
    content: [
      ...text === '' ? [] : [{ type: 'text' as const, text }],
      {
        type: 'image',
        attachment: { attachmentId: refId, mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
      } as never,
    ],
    preview: text, text: null,
  }
}

describe('QueueDock', () => {
  it('renders null while the queue is empty', () => {
    const snap = snapshotWith([])
    const source = liveSession(snap)
    const { container } = render(<QueueDock {...kitFor(snap)} useSession={source.useSession} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders a queued local echo in the dock and hands off by rpcId', () => {
    const pending = {
      ...snapshotWith([]),
      pendingSubmissions: [{
        requestId: 'req-local-queue' as never,
        placement: 'queued' as const,
        time: 1,
        text: '等待上传',
        attachments: [
          {
            type: 'image' as const,
            value: { previewUrl: 'blob:queue-preview', name: 'queue.png' },
          },
          {
            type: 'file' as const,
            value: {
              attachmentId: 'file-local' as never,
              name: 'notes.txt',
              bytes: 2447 * 1024 * 1024,
            },
          },
        ],
      }],
    }
    const source = liveSession(pending)
    const props = kitFor(pending)
    const view = render(<QueueDock {...props} useSession={source.useSession} />)
    expect(view.getByText('等待上传').closest('[data-submission-echo]')).not.toBeNull()
    expect(view.getByRole('img', { name: '排队消息图片' }).getAttribute('src')).toBe('blob:queue-preview')
    expect(view.getByLabelText('排队文件 notes.txt').textContent).toContain('2.4GB')
    expect(view.getByRole('status').textContent).toBe('发送中…')
    for (const name of ['编辑排队消息', '删除排队消息', '插话发送']) {
      const button = view.getByRole('button', { name }) as HTMLButtonElement
      expect(button.disabled).toBe(true)
      fireEvent.click(button)
    }
    expect(props.updateQueue).not.toHaveBeenCalled()
    expect(view.queryByRole('textbox')).toBeNull()

    act(() => {
      source.push({
        ...pending,
        queue: [{ ...row('accepted', '等待上传'), rpcId: 'req-local-queue' as never }],
      })
    })
    expect(view.getAllByText('等待上传')).toHaveLength(1)
    expect(view.container.querySelector('[data-submission-echo]')).toBeNull()
    expect(view.queryByRole('status')).toBeNull()
    for (const name of ['编辑排队消息', '删除排队消息', '插话发送']) {
      expect((view.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false)
    }
    fireEvent.click(view.getByRole('button', { name: '编辑排队消息' }))
    expect((view.getByRole('textbox') as HTMLInputElement).value).toBe('等待上传')
  })

  it('keeps sending status visible while a queue containing local submissions is collapsed', () => {
    const pending: SessionSnapshot = {
      ...snapshotWith([row('accepted', '已排队')]),
      pendingSubmissions: [{
        requestId: 'req-waiting' as never, placement: 'queued', time: 1,
        text: '等待发送', attachments: [],
      }],
    }
    const source = liveSession(pending)
    const view = render(<QueueDock {...kitFor(pending)} useSession={source.useSession} />)
    expect(view.getByRole('status').textContent).toBe('发送中…')
    const header = view.getByRole('button', { name: /2 条排队消息\s*发送中…/ })
    expect(header.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(header)
    expect(view.getAllByRole('status')).toHaveLength(1)
    expect(view.getByRole('status').closest('[data-submission-echo]')).not.toBeNull()
    act(() => { source.push(snapshotWith([row('accepted', '已排队')])) })
    expect(view.queryByRole('status')).toBeNull()
  })

  it('leaves pending steering to the conversation flow', () => {
    const steering = { ...row('s-1', 'interrupt'), placement: 'steering' as const }
    const snap = snapshotWith([steering])
    const source = liveSession(snap)
    const { container } = render(<QueueDock {...kitFor(snap)} useSession={source.useSession} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders one row directly and defaults multiple rows to a collapsible count header', () => {
    const single = snapshotWith([row('i-1', 'one')])
    const source = liveSession(single)
    const view = render(<QueueDock {...kitFor(single)} useSession={source.useSession} />)
    expect(view.queryByRole('button', { name: '1 条排队消息' })).toBeNull()
    expect(view.getByText('one')).toBeTruthy()

    act(() => { source.push(snapshotWith([row('i-1', 'one'), row('i-2', 'two')])) })
    const header = view.getByRole('button', { name: '2 条排队消息' })
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(document.getElementById(header.getAttribute('aria-controls')!)).toBeTruthy()
    expect(view.queryByText('one')).toBeNull()
    expect(view.queryByText('two')).toBeNull()

    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText('one')).toBeTruthy()
    expect(view.getByText('two')).toBeTruthy()

    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByText('one')).toBeNull()
  })

  it('keeps an active single-row editor visible when another item arrives', () => {
    const single = snapshotWith([row('i-edit', 'before')])
    const source = liveSession(single)
    const view = render(<QueueDock {...kitFor(single)} useSession={source.useSession} />)

    fireEvent.click(view.getByLabelText('编辑排队消息'))
    fireEvent.change(view.getByLabelText('编辑排队消息'), { target: { value: 'draft' } })
    act(() => {
      source.push(snapshotWith([row('i-edit', 'before'), row('i-2', 'second')]))
    })

    const header = view.getByRole('button', { name: '2 条排队消息' })
    expect(header).toHaveProperty('disabled', true)
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByRole('textbox', { name: '编辑排队消息' })).toHaveProperty('value', 'draft')
    expect(view.getByText('second')).toBeTruthy()

    fireEvent.click(view.getByLabelText('取消编辑'))
    expect(header).toHaveProperty('disabled', false)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByText('second')).toBeNull()
  })

  it('keeps an in-flight row action visible when another item arrives', async () => {
    const single = snapshotWith([row('i-remove', 'remove me')])
    const source = liveSession(single)
    let finishUpdate: (() => void) | undefined
    const updateQueue = vi.fn(() => new Promise<void>((resolve) => { finishUpdate = resolve }))
    const view = render(
      <QueueDock {...kitFor(single, { updateQueue })} useSession={source.useSession} />,
    )

    fireEvent.click(view.getByLabelText('删除排队消息'))
    act(() => {
      source.push(snapshotWith([row('i-remove', 'remove me'), row('i-2', 'second')]))
    })

    const header = view.getByRole('button', { name: '2 条排队消息' })
    expect(header).toHaveProperty('disabled', true)
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText('remove me')).toBeTruthy()
    expect(view.getByText('second')).toBeTruthy()

    expect(updateQueue).toHaveBeenCalledOnce()
    await act(async () => {
      finishUpdate?.()
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(header).toHaveProperty('disabled', false)
      expect(header.getAttribute('aria-expanded')).toBe('false')
    })
  })

  it('defaults a new multi-row queue to collapsed after the prior queue empties', () => {
    const first = snapshotWith([row('i-1', 'one'), row('i-2', 'two')])
    const source = liveSession(first)
    const view = render(<QueueDock {...kitFor(first)} useSession={source.useSession} />)
    fireEvent.click(view.getByRole('button', { name: '2 条排队消息' }))
    expect(view.getByText('one')).toBeTruthy()

    act(() => { source.push(snapshotWith([])) })
    expect(view.container.innerHTML).toBe('')
    act(() => {
      source.push(snapshotWith([row('i-3', 'three'), row('i-4', 'four')]))
    })

    const header = view.getByRole('button', { name: '2 条排队消息' })
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByText('three')).toBeNull()
  })

  it('renders active actions and disables editing for mixed-content rows', () => {
    const snap = snapshotWith([
      row('i-1', '第一条排队消息'),
      row('i-2', null, 'image [image]'),
    ])
    const source = liveSession(snap)
    const { container, getByRole } = render(<QueueDock {...kitFor(snap)} useSession={source.useSession} />)
    fireEvent.click(getByRole('button', { name: '2 条排队消息' }))
    expect([...container.querySelectorAll('li')].map(item => item.textContent))
      .toEqual(['第一条排队消息', 'image [image]'])
    expect(container.querySelectorAll('button')).toHaveLength(7)
    expect(container.querySelectorAll('[aria-label="编辑排队消息"]')).toHaveLength(2)
    expect(container.querySelectorAll('[aria-label="删除排队消息"]')).toHaveLength(2)
    expect(container.querySelectorAll('[aria-label="插话发送"]')).toHaveLength(2)
    expect((container.querySelectorAll('[aria-label="编辑排队消息"]')[0] as HTMLButtonElement).disabled).toBe(false)
    expect((container.querySelectorAll('[aria-label="编辑排队消息"]')[1] as HTMLButtonElement).disabled).toBe(true)
    expect(container.querySelectorAll('[aria-label="编辑排队消息"]')[1]?.getAttribute('title'))
      .toBe('包含非文本内容，暂不支持编辑')
  })

  it('renders queued image thumbnails from durable references beside the text preview', async () => {
    const loadImage = vi.fn(() => Promise.resolve('blob:thumb-1'))
    const snap = snapshotWith([imageRow('i-img', 'att-9', '带图消息')])
    const source = liveSession(snap)
    const { container } = render(
      <QueueDock {...kitFor(snap, { loadImage })} useSession={source.useSession} />,
    )

    await waitFor(() => {
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:thumb-1')
    })
    expect(loadImage).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: 'att-9' }))
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('排队消息图片')
    expect(container.querySelector('li')?.textContent).toBe('带图消息')
  })

  it('renders durable files and images in their original queue order', async () => {
    const loadImage = vi.fn(() => Promise.resolve('blob:mixed'))
    const mixed: QueuedMessage = {
      id: iid('i-mixed'), messageId: 'message-i-mixed' as never, placement: 'queued',
      content: [
        {
          type: 'file',
          attachment: { attachmentId: 'file-durable' as never, name: 'report.csv', bytes: 427 },
        },
        {
          type: 'image',
          attachment: {
            attachmentId: 'image-durable' as never,
            mediaType: 'image/png', bytes: 1, width: 1, height: 1,
          },
        },
      ],
      preview: '', text: null,
    }
    const snap = snapshotWith([mixed])
    const source = liveSession(snap)
    const view = render(<QueueDock {...kitFor(snap, { loadImage })} useSession={source.useSession} />)
    await waitFor(() => { expect(view.container.querySelector('img')).not.toBeNull() })
    const group = view.getByLabelText('排队文件 report.csv').parentElement
    expect(group?.children).toHaveLength(2)
    expect(group?.children[0]?.getAttribute('aria-label')).toBe('排队文件 report.csv')
    expect(group?.children[1]?.tagName).toBe('IMG')
  })

  it('keeps the empty thumbnail placeholder when the image read fails', async () => {
    const loadImage = vi.fn(() => Promise.reject(new Error('read denied')))
    const snap = snapshotWith([imageRow('i-broken', 'att-x')])
    const source = liveSession(snap)
    const { container } = render(
      <QueueDock {...kitFor(snap, { loadImage })} useSession={source.useSession} />,
    )

    await act(async () => { await Promise.resolve() })
    expect(loadImage).toHaveBeenCalled()
    expect(container.querySelector('img')).toBeNull()
  })

  it('ignores a thumbnail resolution landing after unmount', async () => {
    let resolveUrl: ((url: string) => void) | undefined
    const loadImage = vi.fn(() => new Promise<string>((resolve) => { resolveUrl = resolve }))
    const snap = snapshotWith([imageRow('i-late', 'att-late')])
    const source = liveSession(snap)
    const { unmount } = render(
      <QueueDock {...kitFor(snap, { loadImage })} useSession={source.useSession} />,
    )

    unmount()
    await act(async () => {
      resolveUrl?.('blob:late')
      await Promise.resolve()
    })
    expect(loadImage).toHaveBeenCalledTimes(1)
  })

  it('edits text inline with save and cancel controls, then saves with the same item identity', async () => {
    const snap = snapshotWith([row('i-edit', 'before')])
    const source = liveSession(snap)
    const updateQueue = vi.fn(() => Promise.resolve())
    const { getByLabelText, queryByLabelText } = render(
      <QueueDock {...kitFor(snap, { updateQueue })} useSession={source.useSession} />,
    )

    fireEvent.click(getByLabelText('编辑排队消息'))
    const editor = getByLabelText('编辑排队消息') as HTMLInputElement
    expect(getByLabelText('保存排队消息')).toBeTruthy()
    expect(getByLabelText('取消编辑')).toBeTruthy()
    expect(queryByLabelText('删除排队消息')).toBeNull()
    fireEvent.change(editor, { target: { value: 'after' } })
    fireEvent.keyDown(editor, { key: 'Enter' })

    await waitFor(() => {
      expect(updateQueue).toHaveBeenCalledWith(iid('i-edit'), {
        kind: 'edit',
        content: [{ type: 'text', text: 'after' }],
      })
    })
  })

  it('cancels an edit by button or Escape without mutating the queue', () => {
    const snap = snapshotWith([row('i-edit', 'before')])
    const source = liveSession(snap)
    const updateQueue = vi.fn(() => Promise.resolve())
    const { getByLabelText, getByText } = render(
      <QueueDock {...kitFor(snap, { updateQueue })} useSession={source.useSession} />,
    )

    fireEvent.click(getByLabelText('编辑排队消息'))
    fireEvent.change(getByLabelText('编辑排队消息'), { target: { value: 'abandoned' } })
    fireEvent.click(getByLabelText('取消编辑'))
    expect(getByText('before')).toBeTruthy()

    fireEvent.click(getByLabelText('编辑排队消息'))
    fireEvent.keyDown(getByLabelText('编辑排队消息'), { key: 'Escape' })
    expect(getByText('before')).toBeTruthy()
    expect(updateQueue).not.toHaveBeenCalled()
  })

  it('keeps editing during IME composition and disables a blank save', () => {
    const snap = snapshotWith([row('i-edit', 'before')])
    const source = liveSession(snap)
    const updateQueue = vi.fn(() => Promise.resolve())
    const { getByLabelText } = render(
      <QueueDock {...kitFor(snap, { updateQueue })} useSession={source.useSession} />,
    )

    fireEvent.click(getByLabelText('编辑排队消息'))
    const editor = getByLabelText('编辑排队消息')
    fireEvent.change(editor, { target: { value: '   ' } })
    expect(getByLabelText('保存排队消息')).toHaveProperty('disabled', true)
    fireEvent.change(editor, { target: { value: '输入中' } })
    fireEvent.keyDown(editor, { key: 'Enter', isComposing: true })
    expect(updateQueue).not.toHaveBeenCalled()
    expect(getByLabelText('编辑排队消息')).toBeTruthy()
  })

  it('removes the addressed row', async () => {
    const snap = snapshotWith([row('i-1', 'one'), row('i-2', 'two')])
    const source = liveSession(snap)
    const updateQueue = vi.fn(() => Promise.resolve())
    const { getAllByLabelText, getByRole } = render(
      <QueueDock {...kitFor(snap, { updateQueue })} useSession={source.useSession} />,
    )

    fireEvent.click(getByRole('button', { name: '2 条排队消息' }))
    fireEvent.click(getAllByLabelText('删除排队消息')[0]!)
    await waitFor(() => {
      expect(updateQueue).toHaveBeenCalledWith(iid('i-1'), { kind: 'remove' })
    })
  })

  it('strictly steers complete row content only while the agent is running', async () => {
    const running = snapshotWith([row('i-steer', null, 'image [image]')])
    const source = liveSession(running)
    const updateQueue = vi.fn(() => Promise.resolve())
    const rendered = render(
      <QueueDock {...kitFor(running, { updateQueue })} useSession={source.useSession} />,
    )

    const button = rendered.getByLabelText('插话发送')
    expect(button).toHaveProperty('disabled', false)
    fireEvent.click(button)
    await waitFor(() => {
      expect(updateQueue).toHaveBeenCalledWith(iid('i-steer'), { kind: 'steer' })
    })

    act(() => { source.push({ ...running, running: false }) })
    expect(rendered.getByLabelText('插话发送')).toHaveProperty('disabled', true)
    expect(rendered.getByLabelText('插话发送').getAttribute('title')).toBe('仅运行中可插话发送')
  })

  it('renders a session-backed subagent Queue without unsupported actions', () => {
    const snap = {
      ...snapshotWith([row('i-subagent', 'pending child follow-up')]),
      subagent: {
        address: {
          parentSessionId: 'parent' as SessionId,
          childSessionId: SID,
          mode: 'continuable' as const,
        },
        parentAvailable: true,
      },
    }
    const source = liveSession(snap)
    const view = render(
      <QueueDock {...kitFor(snap)} useSession={source.useSession} />,
    )

    expect(view.getByText('pending child follow-up')).toBeTruthy()
    expect(view.queryByLabelText('编辑排队消息')).toBeNull()
    expect(view.queryByLabelText('删除排队消息')).toBeNull()
    expect(view.queryByLabelText('插话发送')).toBeNull()
  })

  it('keeps the row and reports a genuine steer failure', async () => {
    const snap = snapshotWith([row('i-steer-race', 'pending steer')])
    const source = liveSession(snap)
    const notify = vi.fn()
    const updateQueue = vi.fn(() => Promise.reject(new Error('transport failed')))
    const { getByLabelText, getByText } = render(
      <QueueDock {...kitFor(snap, { updateQueue, notify })} useSession={source.useSession} />,
    )

    fireEvent.click(getByLabelText('插话发送'))
    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith(
        'error',
        '插话发送失败，请重试。',
      )
    })
    expect(getByText('pending steer')).toBeTruthy()
  })

  it('keeps the row and surfaces a notice when an operation loses the claim race', async () => {
    const snap = snapshotWith([row('i-race', 'pending')])
    const source = liveSession(snap)
    const notify = vi.fn()
    const updateQueue = vi.fn(() => Promise.reject(new Error('not found')))
    const { getByLabelText, getByText } = render(
      <QueueDock {...kitFor(snap, { updateQueue, notify })} useSession={source.useSession} />,
    )

    fireEvent.click(getByLabelText('删除排队消息'))
    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith('error', '删除失败：这条消息可能已经开始发送。')
    })
    expect(getByText('pending')).toBeTruthy()
  })

  it('follows authoritative retirement back to null', () => {
    const snap = snapshotWith([row('i-1', '在场')])
    const source = liveSession(snap)
    const { container } = render(<QueueDock {...kitFor(snap)} useSession={source.useSession} />)
    expect(container.textContent).toContain('在场')
    act(() => { source.push(snapshotWith([])) })
    expect(container.innerHTML).toBe('')
  })

  it('registers as the terminal composer-context entry', () => {
    expect(queueDockEntry.name).toBe('conversation-queue-dock')
    expect(queueDockEntry.inject).toEqual(['slots', 'conversation', 'sessions', 'uiConversation'])
    const register = vi.fn(() => () => undefined)
    const inject = vi.fn((_name: string, callback: () => () => void) => callback())
    queueDockEntry.apply({ slots: { inject, register } } as never)
    expect(inject).toHaveBeenCalledWith('conversation.input.dock', expect.any(Function))
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'conversation.input.dock', id: 'queue', order: 20 }),
      QueueDock,
    )
  })
})
