import { afterEach, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceId, WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { browserWorkspace } from '../src/client/electron/workspace.ts'

const SESSION = 'session' as SessionId
const workspace = (id: string, path: string, sessionIds: readonly SessionId[]): WorkspaceView => ({
  workspaceId: id as WorkspaceId, path, title: path, sessionIds, createdAt: '', updatedAt: '',
})
const snapshot = (phase: WorkspaceSnapshot['phase'], items: readonly WorkspaceView[] = []): WorkspaceSnapshot => ({
  phase, items, state: 'idle', error: null, archivedSessionIds: [], pinnedSessionIds: [],
})

afterEach(() => { vi.restoreAllMocks() })

it('groups resolved Sessions by canonical CWD rather than Workspace identity', async () => {
  const source = createSnapshotStore(snapshot('ready', [
    workspace('other', '/other', ['other' as SessionId]), workspace('first', '/canonical', [SESSION]),
  ]))
  const signal = new AbortController().signal
  await expect(browserWorkspace(source, SESSION, signal)).resolves.toBe('cwd:/canonical')
  source.set(snapshot('ready', [workspace('renamed', '/canonical', [SESSION])]))
  await expect(browserWorkspace(source, SESSION, signal)).resolves.toBe('cwd:/canonical')
  await expect(browserWorkspace(source, 'unaccounted', signal)).resolves.toBe('session:unaccounted')
})

it('waits for an authoritative baseline and removes the readiness subscription', async () => {
  const source = createSnapshotStore(snapshot('pending'))
  const subscribe = source.subscribe.bind(source)
  const stopped = vi.fn()
  vi.spyOn(source, 'subscribe').mockImplementation((listener) => {
    const stop = subscribe(listener)
    return () => { stop(); stopped() }
  })
  const lifetime = new AbortController()
  const result = browserWorkspace(source, SESSION, lifetime.signal)
  source.set(snapshot('pending', [workspace('partial', '/partial', [SESSION])]))
  expect(stopped).not.toHaveBeenCalled()
  source.set(snapshot('ready', [workspace('ready', '/ready', [SESSION])]))
  await expect(result).resolves.toBe('cwd:/ready')
  expect(stopped).toHaveBeenCalledOnce()
  lifetime.abort()
  expect(stopped).toHaveBeenCalledOnce()
})

it('rejects cancellation before and during readiness without retaining a listener', async () => {
  const source = createSnapshotStore(snapshot('pending'))
  const lifetime = new AbortController()
  const failure = new Error('tab closed')
  const result = browserWorkspace(source, SESSION, lifetime.signal)
  const rejected = expect(result).rejects.toBe(failure)
  lifetime.abort(failure)
  await rejected
  source.set(snapshot('ready'))
  await expect(browserWorkspace(source, SESSION, lifetime.signal)).rejects.toBe(failure)
})
