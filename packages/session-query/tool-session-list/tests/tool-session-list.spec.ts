import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionPersistence, { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionHandle, SessionPersistenceListOptions, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache, { projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache'
import type { CheckpointRecord } from '@deepseek-ai/dsh-session-projection-cache'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import type { SessionEventSearchPage, SessionSearchHit, SessionSearchPage } from '@deepseek-ai/dsh-session-query'
import { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import WorkspaceRegistry, { WorkspaceId, workspaceDomainSpec } from '@deepseek-ai/dsh-workspace'
import type { WorkspaceRecord } from '@deepseek-ai/dsh-workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as ToolSessionList from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

class HeaderPersistence extends SessionPersistence {
  readonly headers: SessionHeader[]

  constructor(ctx: Context, config: { headers: SessionHeader[] }) {
    super(ctx)
    this.headers = config.headers
  }

  override create = vi.fn((): Promise<SessionHandle> => Promise.reject(new Error('listing must not create a stored Session')))
  override open = vi.fn((): Promise<SessionHandle> => Promise.reject(new Error('listing must not open an event log')))
  override flush = vi.fn((): Promise<void> => Promise.resolve())
  override stat = vi.fn((): Promise<SessionPersistenceSnapshot | undefined> => Promise.reject(new Error('listing must not stat each Session')))
  override list = vi.fn((options?: SessionPersistenceListOptions): Promise<SessionPersistenceSnapshot[]> => {
    options?.signal?.throwIfAborted()
    return Promise.resolve(this.headers.map(header => ({ header, revision: SessionPersistenceRevision(`rev-${header.id}`) })))
  })
}

class ListingQuery extends SessionQueryEngine {
  override searchSessions(): Promise<SessionSearchPage<SessionSearchHit>> {
    return Promise.reject(new Error('listing must not search Session contents'))
  }

  override searchEvents(): Promise<SessionEventSearchPage> {
    return Promise.reject(new Error('listing must not search event contents'))
  }
}

function header(id: string, createdAt: number, options: Partial<Pick<SessionHeader, 'cwd' | 'parentSession' | 'origin'>> = {}): SessionHeader {
  return { id: SessionId(id), version: SESSION_FORMAT_VERSION, createdAt, isSeeded: false, ...options }
}

function workspace(path: string, sessionIds: string[] = [], title = 'Workspace'): WorkspaceRecord {
  return {
    path,
    title,
    sessionIds: sessionIds.map(SessionId),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  }
}

function checkpoint(meta: SessionHeader, title: string | null, lastPromptAt: number | null): CheckpointRecord {
  return {
    identity: {
      formatVersion: meta.version,
      createdAt: meta.createdAt,
      isSeeded: false,
      inheritedEventCount: SessionLogOffset(0),
      ...meta.cwd === undefined ? {} : { cwd: meta.cwd },
    },
    rows: {
      title: { ver: 1, seq: -1, val: title },
      sessionListMetadata: { ver: 1, seq: -1, val: { blank: false, lastPromptAt } },
    },
  }
}

async function directory(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-session-list-')))
  roots.push(root)
  return root
}

async function mount(options: {
  headers?: SessionHeader[]
  workspaces?: Array<[string, WorkspaceRecord]>
  archived?: string[]
  cached?: Array<[string, CheckpointRecord]>
  cache?: boolean
} = {}) {
  const workspaces = options.workspaces ?? []
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: await directory() })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const workspaceDomain = await ctx.storageDomain.open(workspaceDomainSpec)
  for (const [id, record] of workspaces) await workspaceDomain.table('workspaces').put(WorkspaceId(id), record)
  await workspaceDomain.global.set({
    initialized: true,
    workspaceIds: workspaces.map(([id]) => WorkspaceId(id)),
    archivedSessionIds: (options.archived ?? []).map(SessionId),
    pinnedSessionIds: [],
  })
  await workspaceDomain.close()
  const cacheDomain = await ctx.storageDomain.open(projectionCacheDomainSpec)
  for (const [id, record] of options.cached ?? []) await cacheDomain.table('sessions').put(SessionId(id), record)
  await cacheDomain.close()
  await ctx.plugin(HeaderPersistence, { headers: options.headers ?? [] })
  await ctx.plugin(WorkspaceRegistry)
  if (options.cache !== false) {
    await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 1000, writeIntervalMs: 60_000 })
  }
  await ctx.sessionProjections.register(titleProjectionDefinition)
  await ctx.plugin(ListingQuery)
  const fiber = await ctx.plugin(ToolSessionList)
  const read = vi.spyOn(ctx.sessionQuery, 'readSession')
  const titles = vi.spyOn(ctx.sessionQuery, 'readTitleSnapshots')
  const open = vi.spyOn(ctx.sessionPersistence, 'open')
  let callId = 0
  return {
    ctx,
    fiber,
    read,
    titles,
    open,
    call: (name: string, args: unknown = {}, signal = new AbortController().signal) => executeToolFixture(ctx, {
      name, arguments: args, callId: ToolCallId(`list-${++callId}`), signal,
    }),
  }
}

function value(result: ToolExecutionResult) {
  if (result.isError) throw new Error(result.error.message)
  return result.value
}

function item(id: string, createdAt: number, updatedAt = createdAt, title: string | null = null) {
  return { session_id: id, title, created_at: new Date(createdAt).toISOString(), updated_at: new Date(updatedAt).toISOString() }
}

function prompt(session: Session) {
  session.append('turn/start', { turn: 1 })
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Human prompt' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

describe('read-only Session list tools', () => {
  it('lists empty Workspaces in registry order and applies offset after that order', async () => {
    const path = await directory()
    const secondPath = join(path, 'second')
    await mkdir(secondPath)
    const first = workspace(path, [], 'First')
    const second = workspace(secondPath, [], 'Second')
    const mounted = await mount({ workspaces: [['z-workspace', first], ['a-workspace', second]] })
    const rows = [first, second].map((record, index) => ({
      workspace_id: index === 0 ? 'z-workspace' : 'a-workspace',
      title: record.title, path: record.path, created_at: record.createdAt, updated_at: record.updatedAt,
    }))
    expect(value(await mounted.call('list_workspace'))).toEqual(rows)
    expect(value(await mounted.call('list_workspace', { limit: 1, offset: 1 }))).toEqual([rows[1]])
    expect(value(await mounted.call('list_workspace', { offset: 2 }))).toEqual([])
    expect(value(await mounted.call('list_session'))).toEqual([])
  })

  it('uses current live metadata, cached cold metadata, and creation time for cache misses without opening logs', async () => {
    const cold = header('cold', 10)
    const live = header('live', 20)
    const missing = header('missing', 30)
    const mounted = await mount({
      headers: [cold, live, missing],
      cached: [['cold', checkpoint(cold, 'Cold title', 100)], ['live', checkpoint(live, 'Old title', 90)]],
    })
    const session = mounted.ctx.sessions.create(live.id, { meta: { createdAt: live.createdAt } })
    expect(value(await mounted.call('list_session'))).toEqual([
      item('cold', 10, 100, 'Cold title'), item('missing', 30), item('live', 20),
    ])
    const human = prompt(session)
    session.append('session/title', { title: 'Live title', messageSeqs: [], source: { kind: 'user' } })
    expect(value(await mounted.call('list_session'))).toEqual([
      item('live', 20, human.time, 'Live title'), item('cold', 10, 100, 'Cold title'), item('missing', 30),
    ])
    expect(mounted.ctx.agents.list()).toEqual([])
    expect(mounted.ctx.sessions.list()).toEqual([session])
    expect(mounted.read).not.toHaveBeenCalled()
    expect(mounted.titles).not.toHaveBeenCalled()
    expect(mounted.open).not.toHaveBeenCalled()
  })

  it('uses creation time and null titles when the optional projection cache is not mounted', async () => {
    const mounted = await mount({ headers: [header('cold', 10)], cache: false })
    expect(value(await mounted.call('list_session'))).toEqual([item('cold', 10)])
    expect(mounted.open).not.toHaveBeenCalled()
  })

  it('keeps the title hint of a predecessor cache without using its activity metadata', async () => {
    const cold = header('predecessor', 10)
    const old = checkpoint(cold, 'Prior title', 100)
    old.identity.formatVersion = SESSION_FORMAT_VERSION - 1
    const mounted = await mount({ headers: [cold], cached: [[cold.id, old]] })
    expect(value(await mounted.call('list_session'))).toEqual([item('predecessor', 10, 10, 'Prior title')])
    expect(mounted.open).not.toHaveBeenCalled()
  })

  it('filters archive status and subagents before sorting and pagination; pins do not reorder results', async () => {
    const mounted = await mount({
      headers: [header('z', 100), header('b', 100), header('a', 100), header('archived', 500), header('child', 200, { origin: 'subagent', parentSession: SessionId('z') })],
      archived: ['archived'],
    })
    await mounted.ctx.workspaceRegistry.pinSession(SessionId('z'))
    expect(value(await mounted.call('list_session', { limit: 1, offset: 1 }))).toEqual([item('b', 100)])
    expect(value(await mounted.call('list_session'))).toEqual([item('a', 100), item('b', 100), item('z', 100)])
    expect(value(await mounted.call('list_session', { archived: true }))).toEqual([item('archived', 500)])
    expect(value(await mounted.call('list_session', { archived: true, offset: 1 }))).toEqual([])
  })

  it('breaks cached-activity ties by ID even when creation order differs', async () => {
    const headers = [header('a', 10), header('b', 20), header('z', 30)]
    const mounted = await mount({ headers, cached: headers.map(meta => [meta.id, checkpoint(meta, null, 100)]) })
    expect(value(await mounted.call('list_session'))).toEqual([
      item('a', 10, 100), item('b', 20, 100), item('z', 30, 100),
    ])
  })

  it('lists recorded non-subagent Workspace members from indexed headers without enumerating the corpus', async () => {
    const path = await directory()
    const otherPath = join(path, 'other')
    await mkdir(otherPath)
    const mounted = await mount({
      headers: [
        header('parent', 10, { cwd: path }),
        header('member', 20, { cwd: path }),
        header('same-cwd', 30, { cwd: path }),
        header('child', 40, { cwd: path, origin: 'subagent', parentSession: SessionId('parent') }),
        header('assigned-child', 50, { cwd: path, origin: 'subagent', parentSession: SessionId('parent') }),
        header('other-member', 60, { cwd: otherPath }),
      ],
      workspaces: [
        ['primary', workspace(path, ['parent', 'member', 'assigned-child'])],
        ['other', workspace(otherPath, ['other-member'])],
      ],
      archived: ['parent'],
    })
    const corpus = vi.spyOn(mounted.ctx.sessionQuery, 'listSessions')
    // Registry startup already listed the stored headers; only later listings matter.
    const stored = vi.spyOn(mounted.ctx.sessionPersistence, 'list')
    stored.mockClear()
    expect(value(await mounted.call('list_session', { workspace_id: 'primary' }))).toEqual([item('member', 20)])
    expect(value(await mounted.call('list_session', { workspace_id: 'primary', archived: true }))).toEqual([item('parent', 10)])
    expect(value(await mounted.call('list_session', { workspace_id: 'other' }))).toEqual([item('other-member', 60)])
    expect(corpus).not.toHaveBeenCalled()
    expect(stored).not.toHaveBeenCalled()
    expect(value(await mounted.call('list_session'))).toEqual([item('other-member', 60), item('same-cwd', 30), item('member', 20)])
    expect(corpus).toHaveBeenCalledOnce()
  })

  it('defaults to twenty rows and accepts the upper page limit', async () => {
    const headers = Array.from({ length: 101 }, (_, index) => header(`session-${String(index).padStart(3, '0')}`, index))
    const mounted = await mount({ headers })
    expect(value(await mounted.call('list_session'))).toHaveLength(20)
    expect(value(await mounted.call('list_session', { limit: 100 }))).toHaveLength(100)
    expect(value(await mounted.call('list_session', { limit: 100, offset: 100 }))).toEqual([item('session-000', 0)])
  })

  it.each(['list_workspace', 'list_session'])('rejects invalid pagination for %s with INVALID_ARGS', async (name) => {
    const mounted = await mount()
    const invalid = [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { offset: -1 }, { offset: 1.5 }, { offset: Number.MAX_SAFE_INTEGER + 1 }]
    for (const args of invalid) {
      const result = await mounted.call(name, args)
      expect(result.isError).toBe(true)
      expect(result.error?.info).toMatchObject({ name: 'ToolArgsError', code: 'INVALID_ARGS' })
    }
  })

  it('rejects an unknown Workspace with a typed failure', async () => {
    const mounted = await mount()
    expect((await mounted.call('list_session', { workspace_id: 'absent' })).error?.info)
      .toMatchObject({ name: 'ToolArgsError', code: 'INVALID_ARGS' })
    expect(mounted.open).not.toHaveBeenCalled()
  })

  it('propagates cancellation during corpus discovery without reading metadata or activating Agents', async () => {
    const mounted = await mount({ headers: [header('cold', 10)] })
    const controller = new AbortController()
    const list = vi.spyOn(mounted.ctx.sessionQuery, 'listSessions').mockImplementation(async (signal) => {
      expect(signal).toBe(controller.signal)
      controller.abort(new Error('list cancelled'))
      return []
    })
    const result = await mounted.call('list_session', {}, controller.signal)
    expect(result.error?.info).toMatchObject({ name: 'AbortError', code: 'ABORTED' })
    expect(list).toHaveBeenCalledOnce()
    expect(mounted.open).not.toHaveBeenCalled()
    expect(mounted.ctx.agents.list()).toEqual([])
  })

  it('registers concurrency-safe generic presentation and releases both tools on disposal', async () => {
    const mounted = await mount()
    for (const name of ['list_workspace', 'list_session']) {
      const tool = mounted.ctx.tools.get(name)
      expect(tool?.isConcurrencySafe?.({})).toBe(true)
      expect(tool?.presentCall?.({})).toMatchObject({ card: 'generic', kind: 'read' })
    }
    const page = { limit: 5, offset: 10 }
    expect(mounted.ctx.tools.get('list_workspace')?.presentCall?.(page)).toMatchObject({ rawInput: page })
    const filters = { workspace_id: 'w1', archived: true, limit: 5, offset: 10 }
    expect(mounted.ctx.tools.get('list_session')?.presentCall?.(filters)).toMatchObject({ rawInput: filters })
    await mounted.fiber.dispose()
    expect(mounted.ctx.tools.get('list_workspace')).toBeUndefined()
    expect(mounted.ctx.tools.get('list_session')).toBeUndefined()
  })
})
