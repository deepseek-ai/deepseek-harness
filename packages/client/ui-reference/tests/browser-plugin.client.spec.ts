/**
 * Web reference source coverage: Remote-backed file/session discovery,
 * deterministic ordering and labels, quoted-path suppression, pick projections, codec
 * round-trip, and registration lifecycle.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  CandidateRequest, ClientSessionContext, InputTriggerCandidate, InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference/types'
import type { SessionReferenceMentionCandidate } from '@deepseek-ai/dsh-session-reference/types'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

const sid = (value: string): SessionId => value as SessionId
const session: ClientSessionContext = { sessionId: sid('target') }
/** The target session's own workspace: candidates in it are the `sameWorkspace` rows. */
const HOME = '/Users/dev'
const CREATED_AT = 1_700_000_000_000
/** Three days after every fixture's createdAt, so age copy is one fixed bucket. */
const NOW = CREATED_AT + 3 * 86_400_000
/** The Host session list dates a row; only a session missing from it falls back to createdAt. */
const UPDATED_AT = NOW - 3_600_000

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => { vi.useRealTimers() })

type RemoteEnvelope<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; details: object } }

type RemoteLookup<T> = (
  agentId: SessionId,
  query: string,
  signal?: AbortSignal,
) => Promise<RemoteEnvelope<T[]>>

function request(
  query: string,
  options: { quoted?: boolean; signal?: AbortSignal } = {},
): CandidateRequest {
  return {
    query,
    quoted: options.quoted ?? false,
    position: 'inline',
    drilled: false,
    signal: options.signal ?? new AbortController().signal,
  }
}

async function bench(
  files: RemoteLookup<FileReferenceCandidate> = vi.fn(() => Promise.resolve({
    ok: true as const,
    value: [
      { path: 'src', kind: 'directory' as const },
      { path: 'docs/a b.md', kind: 'file' as const },
    ],
  })),
  sessions: RemoteLookup<SessionReferenceMentionCandidate> = vi.fn(() => Promise.resolve({
    ok: true as const,
    value: [{
      sessionId: sid('source'),
      label: 'Research',
      cwd: `${HOME}/project`,
      sameWorkspace: false,
      createdAt: CREATED_AT,
      mention: '@[Research](dsh-session:InNvdXJjZSI)',
    }],
  })),
  listed: Record<string, { updatedAt: number }> = {},
): Promise<{ ctx: Context; fiber: ReturnType<Context['plugin']>; source: InputTriggerSource }> {
  const ctx = new Context()
  ctx.provide('sidebarRight', { openResource: vi.fn() })
  let source: InputTriggerSource | undefined
  ctx.provide('inputTriggers', {
    registerSource(candidate: InputTriggerSource) {
      source = candidate
      return () => { source = undefined }
    },
  })
  class RemoteService extends Service {
    readonly $host = { home: HOME, isLoopback: true }

    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  ctx.provide('remote.fileReferences', { list: files })
  ctx.provide('remote.sessionReferenceResolver', { candidates: sessions })
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('sessions', { list: { getSnapshot: () => ({ byId: listed }) } })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  if (source === undefined) throw new Error('reference source was not registered')
  return { ctx, fiber, source }
}

describe('apply', () => {
  it('declares its services and releases the @ reference registration on disposal', async () => {
    expect(inject).toEqual([
      'inputTriggers', 'locale', 'sessions', 'remote', 'remote.fileReferences',
      'remote.sessionReferenceResolver', 'sidebarRight',
    ])
    const { fiber } = await bench()
    let registered: InputTriggerSource | undefined
    const ctx = new Context()
    ctx.provide('sidebarRight', { openResource: vi.fn() })
    ctx.provide('inputTriggers', {
      registerSource(source: InputTriggerSource) {
        registered = source
        return () => { registered = undefined }
      },
    })
    class RemoteService extends Service {
      readonly $host = { home: undefined, isLoopback: false }

      constructor(serviceCtx: Context) {
        super(serviceCtx, 'remote')
      }
    }
    new RemoteService(ctx)
    ctx.provide('remote.fileReferences', { list: () => Promise.resolve({ ok: true, value: [] }) })
    ctx.provide('remote.sessionReferenceResolver', { candidates: () => Promise.resolve({ ok: true, value: [] }) })
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('sessions', { list: { getSnapshot: () => ({ byId: {} }) } })
    const ownFiber = ctx.plugin({ inject: [...inject], apply })
    await ownFiber.await()
    expect(registered).toMatchObject({ trigger: '@', name: 'reference', showGroupTitle: false })
    await ownFiber.dispose()
    expect(registered).toBeUndefined()
    await fiber.dispose()
  })

  it('the node half applies without host-side behavior', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})

describe('candidates', () => {
  it('starts both Remote lookups together and renders files before sessions with stable labels', async () => {
    let releaseFiles!: () => void
    let releaseSessions!: () => void
    const files = vi.fn(() => new Promise<{
      ok: true
      value: { path: string; kind: 'file' | 'directory' }[]
    }>((resolve) => {
      releaseFiles = () => {
        resolve({
          ok: true,
          value: [
            { path: 'src', kind: 'directory' },
            { path: 'docs/a b.md', kind: 'file' },
          ],
        })
      }
    }))
    const sessions = vi.fn(() => new Promise<{
      ok: true
      value: {
        sessionId: SessionId
        label: string
        cwd: string
        sameWorkspace: boolean
        createdAt: number
        mention: string
      }[]
    }>((resolve) => {
      releaseSessions = () => {
        resolve({
          ok: true,
          value: [{
            sessionId: sid('source'),
            label: 'Research',
            cwd: `${HOME}/project`,
            sameWorkspace: false,
            createdAt: CREATED_AT,
            mention: '@[Research](dsh-session:InNvdXJjZSI)',
          }],
        })
      }
    }))
    const { source } = await bench(files, sessions, { source: { updatedAt: UPDATED_AT } })
    const pending = source.candidates(session, request('re'))
    expect(files).toHaveBeenCalledTimes(1)
    expect(sessions).toHaveBeenCalledTimes(1)
    releaseSessions()
    releaseFiles()
    await expect(pending).resolves.toEqual([
      {
        name: 'src/',
        icon: 'folder',
        section: 'Files & folders',
        value: JSON.stringify({ kind: 'file', fileKind: 'directory', label: 'src', mention: '@src/' }),
        drill: true,
      },
      expect.objectContaining({
        name: 'a b.md',
        description: 'docs',
        icon: 'file',
        section: 'Files & folders',
      }),
      expect.objectContaining({
        name: 'Research',
        description: '~/project · 1h',
        icon: 'session',
        section: 'Sessions',
      }),
    ])
  })

  it('suppresses sessions for an open quoted path and degrades each failed domain independently', async () => {
    const files = vi.fn()
      .mockResolvedValueOnce({
        ok: true as const,
        value: [{ path: 'README.md', kind: 'file' as const }],
      })
      .mockResolvedValueOnce({
        ok: false as const,
        error: new RemoteError('gateway/internal', 'file scan failed', {}),
      })
    const sessions = vi.fn(() => Promise.resolve({
      ok: true as const,
      value: [{
        sessionId: sid('source'),
        label: 'Research',
        cwd: `${HOME}/project`,
        sameWorkspace: false,
        createdAt: CREATED_AT,
        mention: '@[Research](dsh-session:InNvdXJjZSI)',
      }],
    }))
    const { source } = await bench(files, sessions)
    const quoted = await source.candidates(session, request('READ', { quoted: true }))
    expect(quoted).toEqual([expect.objectContaining({ name: 'README.md', icon: 'file' })])
    expect(source.onPick({
      candidate: quoted[0]!,
      session,
      position: 'inline',
      via: 'menu',
      action: 'pick',
      span: { start: 0, end: 6, draftRev: 1 },
    })).toEqual({
      insert: {
        source: 'reference',
        ref: '@"README.md"',
        label: 'README.md',
        appearance: 'file',
        clipboardText: '@"README.md"',
      },
    })
    expect(sessions).not.toHaveBeenCalled()
    await expect(source.candidates(session, request('research'))).resolves.toEqual([
      expect.objectContaining({ name: 'Research', icon: 'session' }),
    ])
  })

  it('drops a completed result when the query signal was superseded', async () => {
    const controller = new AbortController()
    const { source } = await bench()
    const pending = source.candidates(session, request('', { signal: controller.signal }))
    controller.abort()
    await expect(pending).resolves.toEqual([])
  })

  it('treats Remote failures as empty domains and filters paths that cannot be mentioned', async () => {
    const files = vi.fn(() => Promise.resolve({
      ok: true as const,
      value: [{ path: 'bad\nname', kind: 'file' as const }],
    }))
    const sessions = vi.fn(() => Promise.resolve({
      ok: false as const,
      error: new RemoteError('gateway/internal', 'session lookup failed', {}),
    }))
    const { source } = await bench(files, sessions)
    await expect(source.candidates(session, request('bad'))).resolves.toEqual([])

    files.mockResolvedValueOnce({
      ok: false as const,
      error: new RemoteError('gateway/internal', 'file lookup failed', {}),
    } as never)
    await expect(source.candidates(session, request('bad'))).resolves.toEqual([])
  })

  it('labels a session without a cwd and still dates it', async () => {
    const files = vi.fn(() => Promise.resolve({ ok: true as const, value: [] }))
    const sessions = vi.fn(() => Promise.resolve({
      ok: true as const,
      value: [{
        sessionId: sid('same'),
        label: 'same',
        sameWorkspace: false,
        createdAt: CREATED_AT,
        mention: '@[same](dsh-session:InNhbWUi)',
      }],
    }))
    const { source } = await bench(files, sessions)
    await expect(source.candidates(session, request('same'))).resolves.toEqual([
      expect.objectContaining({
        name: 'same',
        description: '(no cwd) · 3d',
      }),
    ])
  })

  it('falls back to the candidate createdAt for a session the Host list does not carry', async () => {
    const files = vi.fn(() => Promise.resolve({ ok: true as const, value: [] }))
    const sessions = vi.fn(() => Promise.resolve({
      ok: true as const,
      value: [{
        sessionId: sid('unlisted'),
        label: 'Unlisted run',
        cwd: `${HOME}/project`,
        sameWorkspace: true,
        createdAt: CREATED_AT,
        mention: '@[Unlisted run](dsh-session:InVubGlzdGVkIg)',
      }],
    }))
    // A row absent from the list has no durable activity time to read.
    const { source } = await bench(files, sessions, { other: { updatedAt: UPDATED_AT } })
    await expect(source.candidates(session, request('unlisted'))).resolves.toEqual([
      expect.objectContaining({ name: 'Unlisted run', description: '3d' }),
    ])
  })

  it('reads a session opened moments ago as the present, not a zero distance', async () => {
    const files = vi.fn(() => Promise.resolve({ ok: true as const, value: [] }))
    const sessions = vi.fn(() => Promise.resolve({
      ok: true as const,
      value: [{
        sessionId: sid('just-now'),
        label: 'Just now',
        cwd: `${HOME}/project`,
        sameWorkspace: true,
        createdAt: NOW - 1_000,
        mention: '@[Just now](dsh-session:Imp1c3Qtbm93Ig)',
      }],
    }))
    const { source } = await bench(files, sessions, { 'just-now': { updatedAt: NOW - 1_000 } })
    await expect(source.candidates(session, request('just'))).resolves.toEqual([
      expect.objectContaining({ name: 'Just now', description: 'now' }),
    ])
  })

  it('dates a session in the current workspace without repeating that workspace', async () => {
    const files = vi.fn(() => Promise.resolve({ ok: true as const, value: [] }))
    const sessions = vi.fn(() => Promise.resolve({
      ok: true as const,
      value: [{
        sessionId: sid('sibling'),
        label: 'Sibling run',
        cwd: `${HOME}/project`,
        sameWorkspace: true,
        createdAt: CREATED_AT,
        mention: '@[Sibling run](dsh-session:InNpYmxpbmdyIg)',
      }],
    }))
    const { source } = await bench(files, sessions)
    await expect(source.candidates(session, request('sib'))).resolves.toEqual([
      expect.objectContaining({ name: 'Sibling run', description: '3d' }),
    ])
  })
})

describe('directory header', () => {
  const drilledRequest = (query: string, quoted = false): CandidateRequest => ({
    query,
    quoted,
    position: 'inline',
    drilled: true,
    signal: new AbortController().signal,
  })

  it('publishes no header for a query the user typed', async () => {
    const { source } = await bench()
    expect(source.header?.(session, { query: 'src/module1/', drilled: false })).toBeUndefined()
  })

  it('publishes no header until a drilled query names a directory', async () => {
    const { source } = await bench()
    expect(source.header?.(session, { query: 'src', drilled: true })).toBeUndefined()
  })

  it('trails the workspace root down to the directory being listed', async () => {
    const { source } = await bench()
    expect(source.header?.(session, { query: 'src/module1/ind', drilled: true })).toEqual([
      { label: 'Workspace', value: JSON.stringify({ kind: 'file', fileKind: 'directory', label: 'Workspace', mention: '@' }) },
      { label: 'src', value: JSON.stringify({ kind: 'file', fileKind: 'directory', label: 'src', mention: '@src/' }) },
      {
        label: 'module1',
        value: JSON.stringify({ kind: 'file', fileKind: 'directory', label: 'module1', mention: '@src/module1/' }),
        current: true,
      },
    ])
  })

  it('keeps an open quote across every crumb of a quoted descent', async () => {
    const { source } = await bench()
    const crumbs = source.header?.(session, { query: 'my dir/sub/', quoted: true, drilled: true })
    expect(crumbs?.map(crumb => JSON.parse(crumb.value) as { mention: string }).map(value => value.mention))
      .toEqual(['@"', '@"my dir/', '@"my dir/sub/'])
  })

  it('publishes no header when a segment cannot be written back as mention text', async () => {
    const { source } = await bench()
    expect(source.header?.(session, { query: 'ok/we\u0001ird/', drilled: true })).toBeUndefined()
  })

  it('returns to a crumb through the same drill outcome a folder row uses', async () => {
    const { source } = await bench()
    const crumbs = source.header?.(session, { query: 'src/module1/', drilled: true })
    expect(source.onPick({
      candidate: { name: 'src', value: crumbs?.[1]?.value ?? '' },
      session,
      position: 'inline',
      via: 'menu',
      action: 'drill',
      span: { start: 0, end: 13, draftRev: 1 },
    })).toEqual({ text: '@src/', continue: true })
  })

  it('drops the row location a drilled listing already shows in its header', async () => {
    const files = vi.fn(() => Promise.resolve({
      ok: true as const,
      value: [{ path: 'src/module1/index.html', kind: 'file' as const }],
    }))
    const sessions = vi.fn(() => Promise.resolve({ ok: true as const, value: [] }))
    const { source } = await bench(files, sessions)
    await expect(source.candidates(session, drilledRequest('src/module1/'))).resolves.toEqual([
      expect.objectContaining({ name: 'index.html', icon: 'file' }),
    ])
    const [row] = await source.candidates(session, drilledRequest('src/module1/'))
    expect(row).not.toHaveProperty('description')
  })
})

describe('pick and codec', () => {
  const pickAs = (action: 'pick' | 'drill') =>
    (source: InputTriggerSource, candidate: InputTriggerCandidate) => source.onPick({
      candidate,
      session,
      position: 'inline',
      via: 'menu',
      action,
      span: { start: 0, end: 1, draftRev: 1 },
    })
  const pick = pickAs('pick')
  const drill = pickAs('drill')

  it('settles files and directories as atomic icon labels; drill keeps directory completion open', async () => {
    const { source } = await bench()
    const [directory, file] = await source.candidates(session, request(''))
    expect(directory?.drill).toBe(true)
    expect(file?.drill).toBeUndefined()
    expect(pick(source, directory!)).toEqual({
      insert: {
        source: 'reference',
        ref: '@src/',
        label: 'src/',
        appearance: 'folder',
        clipboardText: '@src/',
      },
    })
    expect(drill(source, directory!)).toEqual({ text: '@src/', continue: true })
    expect(pick(source, file!)).toEqual({
      insert: {
        source: 'reference',
        ref: '@"docs/a b.md"',
        label: 'a b.md',
        appearance: 'file',
        clipboardText: '@"docs/a b.md"',
      },
    })
    const [quotedDirectory] = await source.candidates(session, request('', { quoted: true }))
    expect(drill(source, quotedDirectory!)).toEqual({ text: '@"src/', continue: true })
  })

  it('inserts sessions as atomic chips whose clipboard and model forms are canonical mentions', async () => {
    const { source } = await bench()
    const candidates = await source.candidates(session, request(''))
    const candidate = candidates.find(item => item.name === 'Research')!
    const mention = '@[Research](dsh-session:InNvdXJjZSI)'
    expect(pick(source, candidate)).toEqual({
      insert: {
        source: 'reference',
        ref: mention,
        label: 'Research',
        appearance: 'session',
        clipboardText: mention,
      },
    })
    expect(source.codec?.clipboardText(mention)).toBe(mention)
    await expect(source.codec?.serialize(mention, new AbortController().signal)).resolves.toBe(mention)
  })

  it('ignores candidates that do not carry a source-owned value', async () => {
    const { source } = await bench()
    expect(pick(source, { name: 'foreign candidate' })).toBeUndefined()
  })
})

describe('reference preview', () => {
  it('opens plain and quoted file references without treating folders or sessions as files', async () => {
    const { ctx, source, fiber } = await bench()
    const openResource = vi.spyOn(ctx.sidebarRight, 'openResource')
    expect(source.openReference?.(session, { ref: '@notes/readme.md', appearance: 'file' })).toBe(true)
    expect(source.openReference?.(session, { ref: '@"docs/a b.md"', appearance: 'file' })).toBe(true)
    expect(openResource).toHaveBeenNthCalledWith(1, 'dsh-resource://file/session/target/notes/readme.md')
    expect(openResource).toHaveBeenNthCalledWith(2, 'dsh-resource://file/session/target/docs/a%20b.md')
    expect(source.openReference?.(session, { ref: '@docs/', appearance: 'folder' })).toBe(false)
    expect(source.openReference?.(session, { ref: '@[Research](dsh-session:abc)', appearance: 'session' })).toBe(false)
    expect(openResource).toHaveBeenCalledTimes(2)
    await fiber.dispose()
  })
})
