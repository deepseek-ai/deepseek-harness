import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ISessions,
  SessionFace,
  SessionReference,
  SessionSnapshot,
} from '@deepseek-ai/dsh-api-session-controller/client'
import { createTaskRequester } from '../src/client/actions.ts'
import type { TaskRequest } from '../src/client/actions.ts'
import { en } from '../src/client/locales.ts'
import { reportId, taskId, treeId } from '../src/records.ts'
import { editRequestSchema, TIMELINE_CHANNEL, TIMELINE_EDIT } from '../src/protocol.ts'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'

const id = SessionId('timeline-action-test')
const request: TaskRequest = {
  action: 'pause',
  tree: { id: treeId.parse('plan'), title: 'Release plan' },
  task: { id: taskId.parse('verify'), title: 'Verify behavior' },
}
function fixture(running = false) {
  let snapshot: SessionSnapshot = {
    sessionId: id,
    running,
    removed: false,
    openState: 'open',
    pendingSubmissions: [],
    subagent: null,
    openError: null,
    hasMore: false,
    loadingOlder: false,
    historyLoadStatus: 'idle',
    historyWasPartial: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
    promptAttempted: false,
    awaitingFirstTurn: false,
  }
  const prompt = vi.fn<SessionFace['prompt']>().mockResolvedValue({ ok: true, value: { accepted: true } })
  const session: SessionFace = {
    sessionId: id,
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    projections: { faceOf: () => ({ getSnapshot: () => undefined, subscribe: () => () => undefined }) },
    prompt,
    beginSubmission: vi.fn(),
    readAttachment: vi.fn(),
    updateQueue: vi.fn(),
    cancel: vi.fn(),
    rename: vi.fn(),
    loadOlder: vi.fn(),
    consumeOlder: vi.fn(),
    loadThrough: vi.fn(),
    command: vi.fn(),
  }
  const binding = { session }
  const reference = { sessionId: id, binding, ready: Promise.resolve(binding) } as SessionReference
  let retained = 0
  const using: ISessions['using'] = async (target, options, operation) => {
    expect(target).toBe(id)
    expect(options.source).toBe('timelineTaskAction')
    options.signal?.throwIfAborted()
    retained++
    try {
      return await operation(reference)
    } finally {
      retained--
    }
  }
  const edit = vi
    .fn<(...args: unknown[]) => Promise<ConnectionRpcResult<unknown>>>()
    .mockImplementation((...args) => {
      const input = editRequestSchema.parse(args[2])
      return Promise.resolve({
        ok: true,
        value:
          input.action === 'control'
            ? {
              action: 'control',
              dispatch: true,
              annotation: {
                id: input.id,
                target: input.target,
                text: input.text,
                createdAt: 1,
                reply: null,
                control: { action: input.intent, delivery: 'sending', outcome: null },
              },
              context: {
                target: input.target,
                treeTitle: 'Release plan',
                taskTitle: input.target.kind === 'task' ? 'Verify behavior' : null,
              },
            }
            : { action: input.action },
      })
    })
  const requester = createTaskRequester(
    { using },
    { rpc: { call: edit } },
    key => en[key as keyof typeof en],
  )
  return {
    requester,
    prompt,
    edit,
    update: (value: Partial<SessionSnapshot>) => {
      snapshot = { ...snapshot, ...value }
    },
    retained: () => retained,
  }
}

describe('task controls through normal Session admission', () => {
  it('includes report findings, questions and user actions, and handles declined admission', async () => {
    const f = fixture()
    const note = { id: 'note-0000000000000001', target: { kind: 'report' as const, report: reportId.parse('check') }, text: 'Review this interval.' }
    const annotation = { ...note, createdAt: 1, reply: null }
    const context = { summary: {
      progress: ['The new fixture passes.'], uncertainties: ['Backup restore is still open.'], userActions: ['Supply a backup sample.'],
    } }
    try {
      f.edit.mockResolvedValueOnce({ ok: true, value: { action: 'annotate', annotation, context } })
      const error = Object.assign(new Error('Admission declined'), {
        isDSHRemoteError: true as const,
        code: 'session/agent-busy' as const,
        details: { reason: 'Conversation closed' },
      })
      f.prompt.mockResolvedValueOnce({ ok: false, error })
      expect(await f.requester.annotate(id, note)).toEqual({ notified: false })
      const block = f.prompt.mock.calls[0]?.[0][0]
      expect(block?.type === 'text' && block.text).toContain('Supply a backup sample.')
      f.edit.mockResolvedValueOnce({ ok: true, value: { action: 'annotate', annotation, context: null } })
      expect(await f.requester.annotate(id, note)).toEqual({ notified: true })
      f.edit.mockResolvedValueOnce({ ok: false, error: { code: 'test/edit', message: 'Edit declined', details: {} } })
      await expect(f.requester.annotate(id, note)).rejects.toThrow('Edit declined')
    } finally {
      await f.requester.close()
    }
  })
  it('returns acknowledged transfer results and rejects a mismatched response for every edit', async () => {
    const f = fixture()
    const imported = { id: 'import-one', content: '{}', copy: false, continue: false }
    const note = { id: 'note-0000000000000001', target: { kind: 'tree' as const, tree: request.tree.id }, text: 'Check scope.' }
    const priority = { tree: request.tree.id, task: taskId.parse('verify'), priority: 'P1' as const }
    try {
      const saved = { action: 'import', tree: request.tree.id, reused: false, notified: false }
      const removed = { action: 'remove', removed: true, notified: false, draft: true }
      f.edit.mockResolvedValueOnce({ ok: true, value: saved }).mockResolvedValueOnce({ ok: true, value: removed })
      expect(await f.requester.importTree(id, imported)).toEqual(saved)
      expect(await f.requester.removeTree(id, request.tree.id, true)).toEqual(removed)
      expect(f.edit.mock.calls[1]?.[2]).toMatchObject({ action: 'remove', draft: true, sessionId: id })
      f.edit.mockResolvedValue({ ok: true, value: { action: 'delivery' } })
      for (const [edit, message] of [
        [() => f.requester.importTree(id, imported), 'import'],
        [() => f.requester.removeTree(id, request.tree.id), 'removal'],
        [() => f.requester.send(id, request), 'request'],
        [() => f.requester.setPriority(id, priority), 'edit'],
        [() => f.requester.annotate(id, note), 'annotation'],
      ] as const) await expect(edit()).rejects.toThrow(`Invalid Timeline ${message} response`)
      f.edit.mockResolvedValue({ ok: true, value: {
        action: 'annotate',
        annotation: { ...note, createdAt: 1, reply: { text: 'Checked.', createdAt: 2 } },
        context: {},
      } })
      expect(await f.requester.annotate(id, note)).toEqual({ notified: true })
      expect(f.prompt).not.toHaveBeenCalled()
    } finally {
      await f.requester.close()
    }
  })
  it('introduces the task discussion before the unchanged user message', async () => {
    const f = fixture(true)
    const note = {
      id: 'note-0000000000000001',
      target: { kind: 'task' as const, tree: request.tree.id, task: taskId.parse('verify') },
      text: 'Approve backup as a remote branch and remove\n\nKeep the saved patch.',
    }
    f.edit.mockResolvedValue({
      ok: true,
      value: {
        action: 'annotate',
        annotation: { ...note, createdAt: 1, reply: null },
        context: {
          treeTitle: 'Release plan',
          taskTitle: 'Verify behavior',
          status: 'done',
          progress: { progress: 1, remaining: 0, status: 'done' },
          description: '',
          details: '',
          priority: null,
          note: 'The review is complete. '.repeat(20),
        },
      },
    })
    try {
      expect(await f.requester.annotate(id, note)).toEqual({ notified: true })
      const block = f.prompt.mock.calls[0]?.[0][0]
      if (block?.type !== 'text') throw new Error('Missing discussion message')
      const [intro, context, guidance, ...user] = block.text.split('\n\n')
      expect(intro).toBe('Timeline · Discussion')
      expect(context).toContain('Task: Verify behavior (verify) · Done')
      expect(context).toContain('Plan: Release plan (plan)')
      expect(guidance).toBe(en.annotationRequest)
      expect(user.join('\n\n')).toBe(`User message:\n${note.text}`)
      expect(block.text).toContain('Latest update:')
      expect(block.text).toContain('…')
      expect(block.text.match(/note-0000000000000001/gu)).toHaveLength(1)
      expect(block.text).not.toContain('"context":')
      expect(block.text).not.toContain('remaining')
      expect(block.text).not.toContain('priority')
      expect(block.text).not.toContain('description')
      expect(block.text).not.toContain('details')
      expect(block.text).toContain('timeline_reply')
      expect(f.prompt.mock.calls[0]?.[1]).toBe('steer')
    } finally {
      await f.requester.close()
    }
  })
  it('saves priority through the owner edit route without sending a conversation message', async () => {
    const f = fixture(true)
    try {
      await f.requester.setPriority(id, {
        tree: request.tree.id,
        task: taskId.parse('verify'),
        priority: 'P0',
      })
      expect(f.edit.mock.calls[0]?.slice(0, 3)).toEqual([
        TIMELINE_CHANNEL,
        TIMELINE_EDIT,
        { sessionId: id, tree: 'plan', task: 'verify', priority: 'P0', action: 'priority' },
      ])
      expect(f.prompt).not.toHaveBeenCalled()
      expect(f.retained()).toBe(0)
    } finally {
      await f.requester.close()
    }
  })
  it('uses stored IDs when titles are missing from a discussion preview', async () => {
    const f = fixture()
    const input = {
      id: 'note-0000000000000001',
      target: { kind: 'task' as const, tree: request.tree.id, task: taskId.parse('verify') },
      text: 'Confirm the checkpoint.',
    }
    try {
      f.edit.mockResolvedValueOnce({
        ok: true,
        value: {
          action: 'annotate',
          annotation: { ...input, createdAt: 1, reply: null },
          context: { description: 'Check restored data.' },
        },
      })
      await expect(f.requester.annotate(id, input)).resolves.toEqual({ notified: true })
      const block = f.prompt.mock.calls[0]?.[0][0]
      expect(block?.type === 'text' && block.text).toContain('Task: verify\nPlan: plan\nDetails: Check restored data.')
    } finally {
      await f.requester.close()
    }
  })
  it('saves report feedback before admission, retains it on notification failure, and rejects failed saves', async () => {
    const f = fixture()
    const note = {
      id: '1dff652b-96c0-4cf0-a6f7-608fe6f40890',
      target: { kind: 'report' as const, report: reportId.parse('history') },
      text: 'What remained at this time?',
    }
    const annotation = { ...note, createdAt: 1, reply: null }
    f.edit.mockResolvedValue({
      ok: true,
      value: {
        action: 'annotate',
        annotation,
        context: {
          report: 'history',
          start: '2026-10-23T00:00:00Z',
          end: '2026-10-23T00:15:00Z',
          summary: { progress: ['Restart was verified.'], uncertainties: [], userActions: [] },
        },
      },
    })
    f.prompt.mockRejectedValueOnce(new Error('Admission outcome unknown'))
    try {
      expect(await f.requester.annotate(id, note)).toEqual({ notified: false })
      expect(f.edit.mock.invocationCallOrder[0]).toBeLessThan(f.prompt.mock.invocationCallOrder[0] ?? 0)
      const message = f.prompt.mock.calls[0]?.[0][0]
      if (message?.type !== 'text') throw new Error('Missing discussion message')
      const [intro, context, guidance, user] = message.text.split('\n\n')
      expect(intro).toBe('Timeline · Discussion')
      expect(context).toContain('Report: 2026-10-23T00:00:00Z – 2026-10-23T00:15:00Z (history)')
      expect(context).toContain('Restart was verified.')
      expect(guidance).toContain('then continue ongoing work')
      expect(user).toBe(`User message:\n${note.text}`)
      f.edit.mockRejectedValueOnce(new Error('Save outcome unknown'))
      await expect(f.requester.annotate(id, note)).rejects.toThrow('Save outcome unknown')
      expect(f.prompt).toHaveBeenCalledOnce()
      f.edit.mockResolvedValueOnce({
        ok: true,
        value: {
          action: 'annotate',
          annotation: { ...annotation, reply: { text: 'A test account was missing.', createdAt: 2 } },
          context: {},
        },
      })
      expect(await f.requester.annotate(id, note)).toEqual({ notified: true })
      expect(f.prompt).toHaveBeenCalledOnce()
      expect(f.retained()).toBe(0)
    } finally {
      await f.requester.close()
    }
  })
  it('steers a running turn with exact task references and releases its Session reference', async () => {
    const f = fixture(true)
    try {
      await f.requester.send(id, request)
      const [content, mode, signal] = f.prompt.mock.calls[0] ?? []
      expect(mode).toBe('steer')
      expect(signal?.aborted).toBe(false)
      expect(JSON.stringify(content)).toContain(en.pauseRequest)
      const text = content?.[0]
      if (text?.type !== 'text') throw new Error('Missing user request')
      expect(text.text.startsWith('Timeline · Work controls\n\n')).toBe(true)
      expect(text.text).toContain('Task: Verify behavior (verify)')
      expect(text.text).toContain('Plan: Release plan (plan)')
      expect(text.text).toMatch(/Reply reference: note-[0-9a-f]{16}/u)
      expect(text.text).not.toContain('"context":')
      expect(f.edit.mock.invocationCallOrder[0]).toBeLessThan(f.prompt.mock.invocationCallOrder[0] ?? 0)
      expect(f.edit.mock.calls.at(-1)?.[2]).toMatchObject({ action: 'delivery', delivery: 'accepted' })
      expect(f.prompt).toHaveBeenCalledOnce()
      expect(f.retained()).toBe(0)
    } finally {
      await f.requester.close()
    }
  })
  it('queues a whole-plan resume when idle and steers pause when running', async () => {
    const f = fixture()
    try {
      await f.requester.send(id, { action: 'resume', tree: request.tree })
      expect(f.prompt.mock.calls[0]?.[1]).toBe('queue')
      expect(JSON.stringify(f.prompt.mock.calls[0]?.[0])).toContain(en.resumeRequest)
      const message = f.prompt.mock.calls[0]?.[0][0]
      if (message?.type !== 'text') throw new Error('Missing user request')
      expect(message.text).toContain('Plan: Release plan (plan)')
      expect(message.text).not.toContain('Task:')
      f.update({ running: true })
      await f.requester.send(id, { ...request, action: 'pause' })
      expect(f.prompt.mock.calls.map(call => call[1])).toEqual(['queue', 'steer'])
    } finally {
      await f.requester.close()
    }
  })
  it('does not retry unknown failures or mutate task status, and rejects removed conversations', async () => {
    const f = fixture(true)
    try {
      f.prompt.mockRejectedValueOnce(new Error('Transport outcome unknown'))
      await f.requester.send(id, request)
      expect(f.prompt).toHaveBeenCalledTimes(1)
      expect(f.edit.mock.calls.at(-1)?.[2]).toMatchObject({ action: 'delivery', delivery: 'unknown' })
      expect(f.retained()).toBe(0)
      f.update({ removed: true })
      await expect(f.requester.send(id, request)).rejects.toThrow(en.taskRequestUnavailable)
      expect(f.prompt).toHaveBeenCalledTimes(1)
    } finally {
      await f.requester.close()
    }
  })
  it('never dispatches a duplicate or an already satisfied request, and never sends after a failed save', async () => {
    const f = fixture()
    try {
      f.edit.mockResolvedValueOnce({
        ok: true,
        value: {
          action: 'control',
          dispatch: false,
          annotation: {
            id: randomUUID(),
            target: { kind: 'tree', tree: 'plan' },
            text: en.pauseRequest,
            createdAt: 1,
            reply: null,
          },
          context: {},
        },
      })
      await f.requester.send(id, request)
      expect(f.prompt).not.toHaveBeenCalled()
      f.edit.mockRejectedValueOnce(new Error('Save outcome unknown'))
      await expect(f.requester.send(id, request)).rejects.toThrow('Save outcome unknown')
      expect(f.prompt).not.toHaveBeenCalled()
    } finally {
      await f.requester.close()
    }
  })
  it('aborts owned admission on disposal and rejects later requests', async () => {
    const f = fixture()
    f.prompt.mockImplementation(
      (_content, _mode, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => { reject(new DOMException('Request cancelled', 'AbortError')) }, { once: true })
        }),
    )
    const result = f.requester.send(id, request)
    await vi.waitFor(() => { expect(f.prompt).toHaveBeenCalledOnce() })
    const rejected = expect(result).rejects.toThrow()
    await f.requester.close()
    await rejected
    expect(f.retained()).toBe(0)
    await expect(f.requester.send(id, request)).rejects.toThrow()
  })
})
