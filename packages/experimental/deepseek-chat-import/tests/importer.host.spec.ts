import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { FileAttachmentRef, ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { importDeepseekChatExport } from '../src/importer.ts'
import type { DeepseekChatImportDependencies, DeepseekChatImportLimits, DeepseekChatImportWorkspace } from '../src/importer.ts'
import type { ExportSessionFile } from '../src/format.ts'
import { damagedZip } from './helpers/zip.ts'

/** Entry names each `ExportArchive.read` call receives. */
const archiveReads = vi.hoisted(() => [] as string[])

// The importer must not re-scan the central directory for images; recording
// every by-name read lets a test assert that.
vi.mock('../src/archive.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/archive.ts')>()
  return {
    ...actual,
    openExportArchive: async (...args: Parameters<typeof actual.openExportArchive>) => {
      const archive = await actual.openExportArchive(...args)
      return {
        ...archive,
        read: (name: string, signal: AbortSignal) => {
          archiveReads.push(name)
          return archive.read(name, signal)
        },
      }
    },
  }
})

beforeEach(() => { archiveReads.length = 0 })

const BASE = Date.UTC(2026, 10, 11, 2, 0, 0)
const at = (ms: number): string => new Date(BASE + ms).toISOString()
const LIMITS: DeepseekChatImportLimits = { maxSessions: 1000, maxEntryBytes: 64 * 1024, maxTitleBytes: 80 }

let root = ''
let WORKSPACE_PATH = ''
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-deepseek-importer-')))
  WORKSPACE_PATH = root
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

/** A two-message conversation whose reply, the newest leaf, is stamped `leafAt` ms after BASE. */
function chat(id: string, leafAt: number, title: string | null = `title ${id}`, status = 'FINISHED'): ExportSessionFile {
  return {
    id, title, inserted_at: at(0),
    messages: [
      { id: 1, parent_id: null, role: 'USER', status: 'FINISHED', inserted_at: at(leafAt - 10), fragments: [{ type: 'REQUEST', content: `question ${id}` }] },
      { id: 2, parent_id: 1, role: 'ASSISTANT', status, inserted_at: at(leafAt), fragments: [{ type: 'RESPONSE', content: `answer ${id}` }] },
    ],
  }
}

/** One `chat_session_index.json` row; the import selects by `updated_at`, then `inserted_at`, then id. */
function indexRow(id: string, updatedAt: number, insertedAt = updatedAt): Record<string, unknown> {
  return {
    id, title: `title ${id}`, pinned: false, inserted_at: at(insertedAt), updated_at: at(updatedAt), message_count: 2,
  }
}

/** The update time of one fixture conversation: the inserted_at of its last message. */
function leafTime(file: ExportSessionFile): number {
  return Date.parse(file.messages.at(-1)?.inserted_at ?? file.inserted_at) - BASE
}

type Entries = Record<string, string | Uint8Array>

function exportEntries(conversations: ExportSessionFile[], options: { index?: readonly unknown[]; extra?: Entries } = {}): Entries {
  return {
    'manifest.json': '{"export_format_version":3}',
    'chat_session_index.json': JSON.stringify(options.index ?? conversations.map(file => indexRow(file.id, leafTime(file)))),
    ...Object.fromEntries(conversations.map(file => [`chat_sessions/${file.id}.json`, JSON.stringify(file)])),
    ...options.extra,
  }
}

function bytesOf(entries: Entries): Record<string, Uint8Array> {
  return Object.fromEntries(Object.entries(entries).map(([entry, value]) => [entry, typeof value === 'string' ? strToU8(value) : value]))
}

function zip(entries: Entries): Uint8Array {
  return zipSync(bytesOf(entries))
}

interface Stored {
  header: SessionHeader
  events: SessionEvent[]
  flushed: boolean
  closed: boolean
}

function harness(overrides: Partial<DeepseekChatImportDependencies> = {}) {
  const stored: Stored[] = []
  const attached: string[] = []
  const snapshots: string[] = []
  const warnings: string[] = []
  const progress: Array<[number, number]> = []
  let next = 0
  const deps: DeepseekChatImportDependencies = {
    persistence: {
      create: (header) => {
        const record: Stored = { header, events: [], flushed: false, closed: false }
        stored.push(record)
        return Promise.resolve({
          append: (events) => { record.events.push(...events); return Promise.resolve() },
          flush: () => { record.flushed = true; return Promise.resolve() },
          close: () => { record.closed = true; return Promise.resolve() },
        })
      },
    },
    projectionCache: { coldSnapshot: (header) => { snapshots.push(header.id) } },
    workspaceRegistered: () => true,
    createId: () => `id-${++next}`,
    warn: (message) => { warnings.push(message) },
    ...overrides,
  }
  const workspace = (): DeepseekChatImportWorkspace => ({
    id: 'workspace-1', path: WORKSPACE_PATH,
    attachSession: (id: SessionId) => { attached.push(id); return Promise.resolve() },
  })
  const run = (
    archive: Uint8Array,
    limits: Partial<DeepseekChatImportLimits> = {},
    signal = new AbortController().signal,
    target = workspace(),
  ) => importDeepseekChatExport(deps, {
    archive, workspace: target, limits: { ...LIMITS, ...limits }, onProgress: (done, total) => { progress.push([done, total]) },
  }, signal)
  return { deps, run, workspace, stored, attached, snapshots, warnings, progress }
}

const titleOf = (record: Stored | undefined): unknown => {
  const event = record?.events.find(item => item.type === 'session/title')
  return event?.type === 'session/title' ? event.data.title : undefined
}

describe('importDeepseekChatExport', () => {
  it('imports the conversations the index selects in update order and reports progress', async () => {
    const { run, stored, attached, snapshots, warnings, progress } = harness()
    const result = await run(zip(exportEntries([
      chat('oldest', 1_000), chat('newest', 9_000), chat('middle', 5_000), chat('tie-b', 3_000), chat('tie-a', 3_000),
    ])), { maxSessions: 4 })
    // The index orders by updated_at; equal times fall back to inserted_at and then to id.
    // The pass writes in archive order: newest, middle, tie-b, tie-a.
    expect(stored.map(titleOf)).toEqual(['title newest', 'title middle', 'title tie-b', 'title tie-a'])
    const ids = stored.map(record => record.header.id)
    // sessionIds reports the imported Sessions newest first, whatever the write order was.
    expect(result).toEqual({
      workspaceId: 'workspace-1', workspacePath: WORKSPACE_PATH,
      sessionIds: [ids[0], ids[1], ids[3], ids[2]], conversationCount: 5, omittedByLimit: 1, skipped: [],
    })
    expect(progress).toEqual([[0, 4], [1, 4], [2, 4], [3, 4], [4, 4]])
    expect(attached).toEqual(ids)
    expect(snapshots).toEqual(ids)
    expect(warnings).toEqual([])
    for (const record of stored) {
      expect(record.header).toEqual({
        version: SESSION_FORMAT_VERSION, id: record.header.id, createdAt: record.events[0]?.time, cwd: WORKSPACE_PATH, isSeeded: false,
      })
      expect(record).toMatchObject({ flushed: true, closed: true })
      expect(record.events.map(event => event.type)).not.toContain('session/end-seed')
    }
    expect(stored[0]?.header.createdAt).toBe(BASE + 8_990)
  })

  it('orders index rows by update time, then insertion time, then id', async () => {
    const { run, stored } = harness()
    const result = await run(zip(exportEntries([chat('a', 1), chat('b', 2), chat('c', 3), chat('d', 4)], {
      index: [
        indexRow('a', 5_000, 1_000), indexRow('b', 5_000, 3_000),
        indexRow('c', 5_000, 3_000), indexRow('d', 5_000, 3_000),
      ],
    })), { maxSessions: 2 })
    expect(stored.map(titleOf)).toEqual(['title b', 'title c'])
    expect(result).toMatchObject({ conversationCount: 4, omittedByLimit: 2 })
  })

  it('imports a conversation the index selects without parsing the ones it does not', async () => {
    const { run, stored, warnings } = harness()
    const result = await run(zip(exportEntries([chat('chosen', 2_000)], {
      extra: { 'chat_sessions/other.json': '{not json' },
    })))
    expect(stored.map(titleOf)).toEqual(['title chosen'])
    expect(warnings).toEqual([])
    expect(result).toMatchObject({ conversationCount: 1, omittedByLimit: 0, skipped: [] })
  })

  it('imports a 2026-11-12 archive by its current message, stages, and notice records', async () => {
    const file: ExportSessionFile = {
      id: 'new-format', title: 'New format', current_message_id: 4, inserted_at: at(0),
      messages: [
        { id: 1, parent_id: null, role: 'USER', status: 'FINISHED', inserted_at: at(10), fragments: [{ type: 'REQUEST', content: 'question' }] },
        {
          id: 2, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', inserted_at: at(12), fragments: [
            { type: 'THINK', content: 'Search first.', elapsed_secs: 1 },
            {
              type: 'TOOL_SEARCH', queries: ['bus'], status: 'FINISHED', stage_id: 1,
              results: [{ url: 'https://a.example/', title: 'A', snippet: 's', published_at: null, site_name: 'A' }],
            },
            { type: 'TOOL_SEARCH', queries: ['broken'], results: [], status: 'FAILED', stage_id: 2 },
            { type: 'TOOL_SEARCH', queries: ['unfinished'], results: [], status: 'WIP', stage_id: 3 },
            {
              type: 'TOOL_OPEN', status: 'FINISHED', url: null, title: null, snippet: null, site_name: null,
              published_at: null, stage_id: 2, group_id: 1,
            },
            { type: 'READ_LINK', results: [{ url: 'https://example.com/link', title: 'Linked page', signature: 'secret' }] },
          ],
        },
        { id: 3, parent_id: 2, role: 'USER', status: 'FINISHED', inserted_at: at(20), fragments: [{ type: 'REQUEST', content: 'second question' }] },
        {
          id: 4, parent_id: 3, role: 'ASSISTANT', status: 'FINISHED', inserted_at: at(22), fragments: [
            { type: 'TIP', content: 'Expert reading links are unavailable.', style: 'INFO' },
            {
              type: 'TOOL_IMAGE_SEARCH', status: 'FINISHED', stage_id: 1,
              results: [{ title: 'one', source_page_url: 'https://x.example/', snippet: 's', site_name: null, published_at: null }],
            },
            { type: 'PARTIAL_FILE_READ', ratio: 58.7599211387782 },
            { type: 'TOOL_FIND', status: 'NO_RESULT', pattern: 'invoice', stage_id: 2 },
            { type: 'RESPONSE', content: 'second answer' },
          ],
        },
        { id: 5, parent_id: 2, role: 'USER', status: 'FINISHED', inserted_at: at(30), fragments: [{ type: 'REQUEST', content: 'abandoned question' }] },
        { id: 6, parent_id: 5, role: 'ASSISTANT', status: 'FINISHED', inserted_at: at(32), fragments: [{ type: 'RESPONSE', content: 'abandoned answer' }] },
      ],
    }
    const { run, stored, warnings } = harness()
    const result = await run(zip(exportEntries([file], { index: [indexRow('new-format', 22)] })))

    expect(result).toMatchObject({ conversationCount: 1, omittedByLimit: 0, skipped: [], sessionIds: [stored[0]?.header.id] })
    expect(warnings).toEqual([])
    expect(stored).toHaveLength(1)
    const record = stored[0]!
    expect(record.events.map(event => event.type)).toEqual([
      'turn/start', 'step/start', 'system/message', 'user/message',
      'assistant/message', 'tool/call', 'tool/result', 'step/end',
      'step/start', 'assistant/message', 'tool/call', 'tool/result', 'step/end',
      'step/start', 'assistant/message', 'step/end', 'turn/end', 'session/title',
      'turn/start', 'step/start', 'user/message',
      // The tip, the image search, the partial read, and the page find replay as nothing.
      'assistant/message', 'step/end', 'turn/end',
    ])
    const assistants = record.events.flatMap(event => event.type === 'assistant/message' ? [event.data] : [])
    expect(assistants.map(data => data.step)).toEqual([1, 2, 3, 1])
    expect(assistants.map(data => data.message.content.map((block) => {
      if (block.type === 'tool-call') return `${block.name} ${block.arguments}`
      return block.type === 'text' ? block.text : block.type
    }))).toEqual([
      ['reasoning', 'web_search {"queries":["bus"]}'],
      // The all-null open beside the failed search replays as nothing.
      ['web_search {"queries":["broken"]}'],
      ['[Linked page](https://example.com/link)'],
      ['second answer'],
    ])
    const calls = record.events.flatMap(event => event.type === 'tool/call' ? [event.data] : [])
    expect(calls.map(call => [call.step, call.arguments])).toEqual([
      [1, '{"queries":["bus"]}'], [2, '{"queries":["broken"]}'],
    ])
    const results = record.events.flatMap(event => event.type === 'tool/result' ? [event.data] : [])
    expect(results.map(data => data.message.isError)).toEqual([false, true])
    expect(results[1]?.message.content).toEqual([{ type: 'text', text: 'Error: the export records this search as failed.' }])
    const asked = record.events.flatMap(event => event.type === 'user/message'
      ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
      : [])
    expect(asked).toEqual(['question', 'second question'])
  })

  it('pulls the next older indexed conversation when a chosen conversation fails conversion', async () => {
    const { run, stored, warnings } = harness()
    const result = await run(zip(exportEntries([
      chat('newest', 9_000, 'Withdrawn', 'CONTENT_FILTER'), chat('middle', 8_000), chat('older', 7_000),
    ])), { maxSessions: 2 })
    expect(stored.map(titleOf)).toEqual(['title middle', 'title older'])
    expect(result.skipped).toEqual([
      { conversationId: 'newest', title: 'Withdrawn', reason: 'every question of the conversation was withdrawn by content filtering' },
    ])
    expect(result).toMatchObject({ conversationCount: 3, omittedByLimit: 0 })
    expect(result.sessionIds).toEqual([stored[0]?.header.id, stored[1]?.header.id])
    expect(warnings).toEqual(result.skipped.map(item => `deepseek-chat-import: conversation ${item.conversationId} was not imported: ${item.reason}`))
  })

  it('reports chosen conversations the archive does not carry and replaces them', async () => {
    const { run, stored, warnings } = harness()
    const result = await run(zip(exportEntries([], {
      index: [indexRow('missing-newest', 9_000), indexRow('missing-older', 8_000)],
    })), { maxSessions: 1 })
    expect(stored).toEqual([])
    expect(result).toEqual({
      workspaceId: 'workspace-1', workspacePath: WORKSPACE_PATH,
      sessionIds: [], conversationCount: 2, omittedByLimit: 0,
      skipped: [
        { conversationId: 'missing-newest', title: null, reason: 'the export has no file for this conversation' },
        { conversationId: 'missing-older', title: null, reason: 'chat_sessions/missing-older.json is not in the export' },
      ],
    })
    expect(warnings).toEqual(result.skipped.map(item => `deepseek-chat-import: conversation ${item.conversationId} was not imported: ${item.reason}`))
  })

  it('reports an oversized chosen conversation and pulls the next older one, ignoring the entries it did not choose', async () => {
    const { run, stored } = harness()
    const result = await run(zip(exportEntries([chat('older', 8_000)], {
      index: [indexRow('bomb', 9_000), indexRow('older', 8_000), indexRow('ignored-bomb', 7_000)],
      extra: {
        'chat_sessions/bomb.json': new Uint8Array(LIMITS.maxEntryBytes + 1),
        'chat_sessions/ignored-bomb.json': new Uint8Array(LIMITS.maxEntryBytes + 1),
      },
    })), { maxSessions: 1 })
    expect(stored.map(titleOf)).toEqual(['title older'])
    expect(result.skipped).toEqual([{
      conversationId: 'bomb', title: null,
      reason: `chat_sessions/bomb.json declares ${LIMITS.maxEntryBytes + 1} uncompressed bytes, more than the ${LIMITS.maxEntryBytes}-byte entry limit`,
    }])
    expect(result).toMatchObject({ conversationCount: 3, omittedByLimit: 1 })
  })

  it('does not import a conversation twice when the index repeats a row', async () => {
    const { run, stored } = harness()
    const result = await run(zip(exportEntries([chat('once', 1_000)], {
      index: [indexRow('once', 1_000), indexRow('once', 900)],
    })))
    expect(stored.map(titleOf)).toEqual(['title once'])
    expect(result).toMatchObject({ conversationCount: 1, omittedByLimit: 0, skipped: [] })
  })

  it('reports a Session that was stored but not added to the workspace and continues', async () => {
    const { run, stored, workspace } = harness()
    const target = workspace()
    let calls = 0
    const flaky = {
      ...target,
      attachSession: (id: SessionId) => ++calls === 1 ? Promise.reject(new Error('ledger write failed')) : target.attachSession(id),
    }
    const result = await run(zip(exportEntries([chat('first', 1_000), chat('second', 2_000)])), {}, undefined, flaky)
    expect(result.skipped).toEqual([{
      conversationId: 'first', title: 'title first', reason: `stored as Session ${stored[0]?.header.id} but not added to the workspace: ledger write failed`,
    }])
    expect(result.sessionIds).toEqual([stored[1]?.header.id])
  })

  it('stops with workspace-not-found when the workspace is removed during the import', async () => {
    let registered = true
    const removed = harness({ workspaceRegistered: () => registered })
    const archive = zip(exportEntries([chat('first', 1_000), chat('second', 2_000)]))
    const target = removed.workspace()
    const removing = { ...target, attachSession: (id: SessionId) => { registered = false; return target.attachSession(id) } }
    await expect(removed.run(archive, {}, undefined, removing))
      .rejects.toThrow(expect.objectContaining({ reason: 'workspace-not-found', message: 'workspace workspace-1 was removed during the import' }))
    expect(removed.stored).toHaveLength(1)
    const gone = harness()
    await expect(gone.run(archive, {}, undefined, { ...gone.workspace(), path: join(root, 'deleted') }))
      .rejects.toMatchObject({ reason: 'workspace-not-found' })
    expect(gone.stored).toEqual([])
  })

  it('continues after a storage failure and closes the handle', async () => {
    const close = vi.fn(() => Promise.resolve())
    const { run } = harness({
      persistence: { create: () => Promise.resolve({ append: () => Promise.reject(new Error('append failed')), flush: () => Promise.resolve(), close }) },
      warn: () => {},
    })
    const result = await run(zip(exportEntries([chat('only', 1_000)])))
    expect(result).toMatchObject({ sessionIds: [], skipped: [{ conversationId: 'only', title: 'title only', reason: 'append failed' }] })
    expect(close).toHaveBeenCalledOnce()
  })

  it('writes without a projection cache and normalizes titles', async () => {
    const { deps, stored, workspace } = harness()
    const { projectionCache: _omitted, ...withoutCache } = deps
    await importDeepseekChatExport(withoutCache, {
      archive: zip(exportEntries([chat('untitled', 1_000, null), chat('long', 2_000, `Line one\nline two ${'x'.repeat(100)}`)])),
      workspace: workspace(), limits: { ...LIMITS, maxTitleBytes: 20 }, onProgress: () => {},
    }, new AbortController().signal)
    expect(stored.map(titleOf)).toEqual([undefined, 'Line one line two xx'])
  })

  it('rejects archives it cannot import before writing anything', async () => {
    const { run, stored } = harness()
    const base = exportEntries([chat('a', 1)])
    await expect(run(zip({ 'chat_sessions/a.json': JSON.stringify(chat('a', 1)) })))
      .rejects.toMatchObject({ reason: 'missing-manifest' })
    await expect(run(zip({ ...base, 'chat_session_index.json': '[]' }), { maxSessions: 1 }))
      .rejects.toMatchObject({ reason: 'no-conversations', message: 'the export contains no importable conversation' })
    await expect(run(zip({ ...base, 'chat_session_index.json': 'not json' })))
      .rejects.toMatchObject({ reason: 'missing-index' })
    await expect(run(zip({ ...base, 'chat_session_index.json': JSON.stringify([{ id: 'a', inserted_at: 'soon', updated_at: 'soon' }]) })))
      .rejects.toMatchObject({ reason: 'missing-index' })
    await expect(run(zip({ ...base, 'chat_session_index.json': new Uint8Array(LIMITS.maxEntryBytes + 1) })))
      .rejects.toMatchObject({ reason: 'too-large' })
    await expect(run(damagedZip(bytesOf({ ...base, 'chat_session_index.json': '' }), 'chat_session_index.json')))
      .rejects.toMatchObject({ reason: 'missing-index', message: 'chat_session_index.json cannot be decompressed' })
    await expect(run(zip({ ...base, 'manifest.json': '{"export_format_version":2}' })))
      .rejects.toMatchObject({ reason: 'unsupported-version' })
    await expect(run(zip({ ...base, 'manifest.json': 'not json' })))
      .rejects.toMatchObject({ reason: 'unsupported-version' })
    await expect(run(zip({ ...base, 'manifest.json': new Uint8Array(LIMITS.maxEntryBytes + 1) })))
      .rejects.toMatchObject({ reason: 'too-large' })
    await expect(run(damagedZip(bytesOf({ ...base, 'manifest.json': '' }), 'manifest.json')))
      .rejects.toMatchObject({ reason: 'unreadable-archive', message: 'manifest.json cannot be decompressed' })
    await expect(run(strToU8('not a zip'))).rejects.toMatchObject({ reason: 'unreadable-archive' })
    expect(stored).toEqual([])
  })

  it('stops at cancellation and keeps the Sessions already written', async () => {
    const controller = new AbortController()
    const { run, stored, workspace } = harness()
    const archive = zip(exportEntries([chat('first', 1_000), chat('second', 2_000)]))
    const target = workspace()
    const aborting = { ...target, attachSession: (id: SessionId) => { controller.abort(new Error('closed')); return target.attachSession(id) } }
    await expect(run(archive, {}, controller.signal, aborting)).rejects.toThrow('closed')
    expect(stored).toHaveLength(1)
    const restart = new AbortController()
    const failing = harness({ persistence: { create: () => { restart.abort(new Error('aborted write')); return Promise.reject(new Error('write failed')) } } })
    await expect(failing.run(archive, {}, restart.signal)).rejects.toThrow('aborted write')
    expect(failing.attached).toEqual([])
    await expect(run(archive, {}, AbortSignal.abort(new Error('before start')))).rejects.toThrow('before start')
    const listing = new AbortController()
    const reading = harness({ warn: () => { listing.abort(new Error('during the pass')) } })
    await expect(reading.run(zip(exportEntries([], {
      index: [indexRow('broken', 1)], extra: { 'chat_sessions/broken.json': '{' },
    })), {}, listing.signal)).rejects.toThrow('during the pass')
  })

  it('reports a replacement conversation that also fails conversion', async () => {
    const { run, stored } = harness()
    const result = await run(zip(exportEntries([
      chat('newest', 9_000, 'Withdrawn', 'CONTENT_FILTER'),
      chat('middle', 8_000, 'Withdrawn too', 'CONTENT_FILTER'),
      chat('older', 7_000),
    ])), { maxSessions: 1 })
    expect(stored.map(titleOf)).toEqual(['title older'])
    expect(result.skipped.map(item => item.conversationId)).toEqual(['newest', 'middle'])
    expect(result).toMatchObject({ conversationCount: 3, omittedByLimit: 0 })
  })

  it('reports a chosen conversation file with an unknown shape', async () => {
    const { run, stored } = harness()
    const result = await run(zip(exportEntries([], {
      index: [indexRow('wrong-shape', 1_000)],
      extra: { 'chat_sessions/wrong-shape.json': JSON.stringify({ id: 'wrong-shape' }) },
    })))
    expect(stored).toEqual([])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]).toMatchObject({ conversationId: 'wrong-shape', title: null })
    expect(result.skipped[0]?.reason).toMatch(/^invalid conversation file: .+; .+/u)
  })

  it('reports a non-Error storage rejection', async () => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a non-Error rejection still names its value
    const { run } = harness({ persistence: { create: () => Promise.reject('quota') }, warn: () => {} })
    const result = await run(zip(exportEntries([chat('only', 1_000)])))
    expect(result.skipped).toEqual([{ conversationId: 'only', title: 'title only', reason: 'quota' }])
  })

})

describe('image attachments', () => {
  function withFiles(id: string, files: Array<{ id: string; name: string; path: string | null; image?: boolean }>): ExportSessionFile {
    const file = chat(id, 1_000)
    file.messages[0] = {
      ...file.messages[0]!,
      fragments: [
        {
          type: 'FILE',
          files: files.map(entry => ({
            id: entry.id, file_name: entry.name, file_size: 3, token_usage: 1, inserted_at: at(0),
            export_path: entry.path, is_image: entry.image ?? true, width: 1, height: 1,
          })),
        },
        { type: 'REQUEST', content: 'Explain' },
      ],
    }
    return file
  }

  function userContent(record: Stored | undefined) {
    const event = record?.events.find(item => item.type === 'user/message')
    return event?.type === 'user/message' ? event.data.content : undefined
  }

  /** A UUID file id, which the export puts before the file name in an image entry. */
  const uuid = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`

  const ref = (name: string): ImageAttachmentRef => ({
    attachmentId: AttachmentId(`sha256:${name.padEnd(64, '0')}`), mediaType: 'image/png', bytes: 3, width: 1, height: 1, name,
  })

  /** The synthetic card of a `withFiles` entry whose bytes were not stored. */
  const card = (id: string, name: string): { type: 'file'; attachment: FileAttachmentRef } => ({
    type: 'file',
    attachment: { attachmentId: AttachmentId(`sha256:${createHash('sha256').update(`deepseek-chat-export:${id}`).digest('hex')}`), name, bytes: 3 },
  })

  it('reports a conversation with an image when adding it to the workspace fails', async () => {
    const path = `chat_sessions/pictured_files/${uuid(1)}_chart.png`
    const conversation = withFiles('pictured', [
      { id: uuid(1), name: 'chart.png', path },
    ])
    const saveImage = vi.fn((input: SaveImageAttachment) => Promise.resolve(ref(input.name ?? 'unnamed')))
    const base = harness({ attachments: { saveImage } })
    const target = {
      ...base.workspace(),
      attachSession: () => Promise.reject(new Error('ledger write failed')),
    }
    const result = await base.run(zip(exportEntries([conversation], {
      extra: { [path]: new Uint8Array([1]) },
    })), {}, undefined, target)
    expect(base.stored).toHaveLength(1)
    expect(result.sessionIds).toEqual([])
    expect(result.skipped).toEqual([{
      conversationId: 'pictured', title: 'title pictured',
      reason: `stored as Session ${base.stored[0]?.header.id} but not added to the workspace: ledger write failed`,
    }])
  })

  it('stores images whose archive entries precede their conversation', async () => {
    const first = `chat_sessions/pictures_files/${uuid(1)}_chart.png`
    const second = `chat_sessions/pictures_files/${uuid(2)}_plan.png`
    const never = `chat_sessions/pictures_files/${uuid(3)}_never.png`
    const conversation = withFiles('pictures', [
      { id: uuid(1), name: 'chart.png', path: first },
      { id: uuid(2), name: 'plan.png', path: second },
      { id: uuid(3), name: 'never.png', path: never },
      { id: uuid(4), name: 'report.pdf', path: null, image: false },
    ])
    const saveImage = vi.fn((input: SaveImageAttachment) => Promise.resolve(ref(input.name ?? 'unnamed')))
    const { run, stored, warnings } = harness({ attachments: { saveImage } })
    // The image pass runs before any conversion, so an archive that puts the
    // images first still attaches them.
    const result = await run(zip({
      'manifest.json': '{"export_format_version":3}',
      'chat_session_index.json': JSON.stringify([indexRow('pictures', 1_000)]),
      [first]: new Uint8Array([1, 2, 3]),
      [second]: new Uint8Array([4, 5]),
      'chat_sessions/pictures.json': JSON.stringify(conversation),
    }))
    expect(result.skipped).toEqual([])
    expect(stored.map(titleOf)).toEqual(['title pictures'])
    expect(saveImage.mock.calls.map(([input]) => [input.name, input.mediaType, [...input.data]])).toEqual([
      ['chart.png', 'image/png', [1, 2, 3]],
      ['plan.png', 'image/png', [4, 5]],
    ])
    expect(userContent(stored[0])).toEqual([
      { type: 'image', attachment: ref('chart.png') },
      { type: 'image', attachment: ref('plan.png') },
      card(uuid(3), 'never.png'),
      card(uuid(4), 'report.pdf'),
      { type: 'text', text: 'Explain' },
    ])
    expect(warnings).toEqual([`deepseek-chat-import: image ${never} is not stored: not in the export`])
  })

  it('imports a pictured question answered by an image search and opened pages', async () => {
    // The 2026-11-12 exporter's structure for a question that carried one image:
    // the FILE fragment names the image entry, the reply searches by image,
    // opens the landing pages, and writes one all-null open as a stage marker.
    const id = 'macaw'
    const path = `chat_sessions/${id}_files/${uuid(1)}_image.png`
    const file: ExportSessionFile = {
      id, title: 'Scarlet macaw', inserted_at: at(0), current_message_id: 2,
      messages: [
        {
          id: 1, parent_id: null, role: 'USER', status: 'FINISHED', inserted_at: at(10), fragments: [
            {
              type: 'FILE', files: [{
                id: uuid(1), file_name: 'image.png', file_size: 5, token_usage: 194, inserted_at: at(9),
                export_path: path, is_image: true, width: 317, height: 269,
              }],
            },
            { type: 'REQUEST', content: 'What is this?' },
          ],
        },
        {
          id: 2, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', inserted_at: at(20), fragments: [
            { type: 'THINK', content: 'Search by image first.', elapsed_secs: 0.9 },
            {
              type: 'TOOL_IMAGE_SEARCH', status: 'FINISHED', results: [
                { title: 'Cuban amazon', source_page_url: 'http://a.example/baike', snippet: 'A parrot.', site_name: null, published_at: null },
                { title: 'Portrait of a macaw', source_page_url: 'https://b.example/macaw', snippet: 'Colorful feathers', site_name: 'B', published_at: null },
              ],
            },
            { type: 'THINK', content: 'Open two pages.', elapsed_secs: 1.5 },
            { type: 'TOOL_OPEN', status: 'FINISHED', url: 'https://b.example/macaw', title: 'Portrait of a macaw', snippet: 'Colorful', site_name: 'B', published_at: null },
            { type: 'TOOL_OPEN', status: 'FINISHED', url: 'http://c.example/scarlet', title: 'Scarlet macaw photos', snippet: '', site_name: null, published_at: null },
            { type: 'TOOL_OPEN', status: 'FINISHED', url: null, title: null, snippet: null, site_name: null, published_at: null, stage_id: 2, group_id: 1 },
            { type: 'THINK', content: 'Both point to a scarlet macaw.', elapsed_secs: 0.8 },
            { type: 'RESPONSE', content: 'A scarlet macaw (*Ara macao*).' },
          ],
        },
      ],
    }
    const saveImage = vi.fn((input: SaveImageAttachment) => Promise.resolve(ref(input.name ?? 'unnamed')))
    const { run, stored, warnings } = harness({ attachments: { saveImage } })
    const result = await run(zip({
      'manifest.json': '{"export_format_version":3}',
      'user.json': '{"id":"u"}',
      [`chat_sessions/${id}.json`]: JSON.stringify(file),
      'chat_session_index.json': JSON.stringify([indexRow(id, 20)]),
      [path]: new Uint8Array([137, 80, 78, 71, 13]),
    }))
    expect(result.skipped).toEqual([])
    expect(warnings).toEqual([])
    expect(saveImage.mock.calls.map(([input]) => [input.name, input.mediaType, [...input.data]])).toEqual([['image.png', 'image/png', [137, 80, 78, 71, 13]]])
    const record = stored[0]!
    expect(userContent(record)).toEqual([{ type: 'image', attachment: ref('image.png') }, { type: 'text', text: 'What is this?' }])
    const calls = record.events.flatMap(event => event.type === 'tool/call' ? [event.data] : [])
    // The image search and the all-null open replay as nothing: the website
    // shows the reasoning, the two opened pages, and the answer.
    expect(calls.map(call => [call.step, call.name, call.arguments])).toEqual([
      [1, 'web_fetch', '{"url":"https://b.example/macaw"}'],
      [1, 'web_fetch', '{"url":"http://c.example/scarlet"}'],
    ])
    const results = record.events.flatMap(event => event.type === 'tool/result' ? [event.data] : [])
    expect(results.map(data => data.message.isError)).toEqual([false, false])
    expect(results[0]?.meta).toEqual({ url: 'https://b.example/macaw', statusCode: 200, truncated: false })
    const reasoning = record.events.flatMap(event => event.type === 'assistant/message'
      ? event.data.message.content.flatMap(block => block.type === 'reasoning' ? [block.text] : [])
      : [])
    expect(reasoning).toEqual(['Search by image first.', 'Open two pages.', 'Both point to a scarlet macaw.'])
    // Nothing of the reply is left as bracketed notice text.
    const texts = record.events.flatMap(event => event.type === 'assistant/message'
      ? event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
      : [])
    expect(texts).toEqual(['A scarlet macaw (*Ara macao*).'])
    expect(record.events.filter(event => event.type === 'turn/end').map(event => event.data.reason)).toEqual([{ kind: 'completed' }])
  })

  it('strips the legacy file-id separator from an image name', async () => {
    const path = `chat_sessions/pictured_files/${uuid(1)}-chart.png`
    const conversation = withFiles('pictured', [
      { id: uuid(1), name: 'chart.png', path },
    ])
    const saveImage = vi.fn((input: SaveImageAttachment) => Promise.resolve(ref(input.name ?? 'unnamed')))
    const { run, stored } = harness({ attachments: { saveImage } })
    await run(zip(exportEntries([conversation], { extra: { [path]: new Uint8Array([1]) } })))
    expect(saveImage.mock.calls.map(([input]) => input.name)).toEqual(['chart.png'])
    expect(userContent(stored[0])).toEqual([{ type: 'image', attachment: ref('chart.png') }, { type: 'text', text: 'Explain' }])
  })

  it('writes synthetic file cards without an attachment service', async () => {
    const path = `chat_sessions/pictured_files/${uuid(1)}_chart.png`
    const conversation = withFiles('pictured', [
      { id: uuid(1), name: 'chart.png', path },
    ])
    const { run, stored, warnings } = harness()
    const result = await run(zip(exportEntries([conversation], {
      extra: { [path]: new Uint8Array([1]) },
    })))
    expect(result.skipped).toEqual([])
    expect(userContent(stored[0])).toEqual([card(uuid(1), 'chart.png'), { type: 'text', text: 'Explain' }])
    expect(warnings).toEqual([])
  })

  it('writes synthetic file cards for images the export lacks or refuses to inflate', async () => {
    const gone = `chat_sessions/missing_files/${uuid(1)}_gone.png`
    const bomb = `chat_sessions/missing_files/${uuid(2)}_oversized-bomb.png`
    const conversation = withFiles('missing', [
      { id: uuid(1), name: 'gone.png', path: gone },
      { id: uuid(2), name: 'bomb.png', path: bomb },
    ])
    const saveImage = vi.fn((input: SaveImageAttachment) => Promise.resolve(ref(input.name ?? 'unnamed')))
    const { run, stored, warnings } = harness({ attachments: { saveImage } })
    await run(zip(exportEntries([conversation], {
      extra: { [bomb]: new Uint8Array(LIMITS.maxEntryBytes + 1) },
    })))
    expect(saveImage).not.toHaveBeenCalled()
    expect(userContent(stored[0])).toEqual([card(uuid(1), 'gone.png'), card(uuid(2), 'bomb.png'), { type: 'text', text: 'Explain' }])
    expect(warnings).toEqual([
      `deepseek-chat-import: image ${gone} is not stored: not in the export`,
      `deepseek-chat-import: image ${bomb} is not stored: ${bomb} declares ${LIMITS.maxEntryBytes + 1} uncompressed bytes, more than the ${LIMITS.maxEntryBytes}-byte entry limit`,
    ])
  })

  it('writes synthetic file cards for unsupported image types and images the store rejects', async () => {
    const bitmap = `chat_sessions/mixed_files/${uuid(1)}_bitmap-old.bmp`
    const rejected = `chat_sessions/mixed_files/${uuid(2)}_rejected-huge.JPG`
    const conversation = withFiles('mixed', [
      { id: uuid(1), name: 'old.bmp', path: bitmap },
      { id: uuid(2), name: 'huge.JPG', path: rejected },
    ])
    const saveImage = vi.fn(() => Promise.reject(new Error('image too large')))
    const { run, stored, warnings } = harness({ attachments: { saveImage } })
    await run(zip(exportEntries([conversation], {
      extra: {
        [bitmap]: new Uint8Array([4]),
        [rejected]: new Uint8Array([5]),
      },
    })))
    expect(saveImage).toHaveBeenCalledOnce()
    expect(userContent(stored[0])).toEqual([card(uuid(1), 'old.bmp'), card(uuid(2), 'huge.JPG'), { type: 'text', text: 'Explain' }])
    expect(warnings).toEqual([
      `deepseek-chat-import: image ${bitmap} is not stored: unsupported image type`,
      `deepseek-chat-import: image ${rejected} is not stored: image too large`,
    ])
  })

  it('stores every image entry of a selected conversation and skips an unselected one', async () => {
    const plainStray = `chat_sessions/plain_files/${uuid(1)}_plain-stray.png`
    const stray = `chat_sessions/pictures_files/${uuid(2)}_stray.png`
    const chart = `chat_sessions/pictures_files/${uuid(3)}_chart.png`
    const other = `chat_sessions/other_files/${uuid(4)}_other.png`
    const otherBomb = `chat_sessions/other_files/${uuid(5)}_bomb.png`
    const plain = chat('plain', 2_000)
    const pictures = withFiles('pictures', [{ id: uuid(3), name: 'chart.png', path: chart }])
    const saveImage = vi.fn((input: SaveImageAttachment) => Promise.resolve(ref(input.name ?? 'unnamed')))
    const { run, warnings } = harness({ attachments: { saveImage } })
    const result = await run(zip(exportEntries([plain, pictures], {
      index: [indexRow('plain', 2_000), indexRow('pictures', 1_000)],
      extra: {
        [plainStray]: new Uint8Array([1]),
        [stray]: new Uint8Array([2]),
        [chart]: new Uint8Array([3]),
        [other]: new Uint8Array([4]),
        [otherBomb]: new Uint8Array(LIMITS.maxEntryBytes + 1),
        'chat_sessions/other.json': JSON.stringify(chat('other', 3_000)),
      },
    })))
    expect(saveImage.mock.calls.map(([input]) => input.name)).toEqual(['plain-stray.png', 'stray.png', 'chart.png'])
    expect(result.skipped).toEqual([])
    expect(warnings).toEqual([])
  })

  it('stores images for a conversation pulled in after a failure', async () => {
    const saved = `chat_sessions/replacement_files/${uuid(1)}_chart.png`
    const gone = `chat_sessions/replacement_files/${uuid(2)}_gone.png`
    const bomb = `chat_sessions/replacement_files/${uuid(3)}_oversized-bomb.png`
    const bitmap = `chat_sessions/replacement_files/${uuid(4)}_bitmap-old.bmp`
    const rejected = `chat_sessions/replacement_files/${uuid(5)}_huge.JPG`
    const replacement = withFiles('replacement', [
      { id: uuid(1), name: 'chart.png', path: saved },
      { id: uuid(2), name: 'gone.png', path: gone },
      { id: uuid(3), name: 'bomb.png', path: bomb },
      { id: uuid(4), name: 'old.bmp', path: bitmap },
      { id: uuid(5), name: 'huge.JPG', path: rejected },
      { id: uuid(6), name: 'report.pdf', path: null, image: false },
    ])
    const saveImage = vi.fn((input: SaveImageAttachment) => input.name === 'huge.JPG'
      ? Promise.reject(new Error('image too large'))
      : Promise.resolve(ref(input.name ?? 'unnamed')))
    const { run, stored, warnings } = harness({ attachments: { saveImage } })
    const result = await run(zip(exportEntries([replacement], {
      index: [indexRow('withdrawn', 9_000), indexRow('replacement', 8_000)],
      extra: {
        'chat_sessions/withdrawn.json': JSON.stringify(chat('withdrawn', 9_000, 'Withdrawn', 'CONTENT_FILTER')),
        [saved]: new Uint8Array([1, 2, 3]),
        [bomb]: new Uint8Array(LIMITS.maxEntryBytes + 1),
        [bitmap]: new Uint8Array([4]),
        [rejected]: new Uint8Array([5]),
      },
    })), { maxSessions: 1 })
    expect(result.skipped.map(item => item.conversationId)).toEqual(['withdrawn'])
    expect(saveImage.mock.calls.map(([input]) => input.name)).toEqual(['chart.png', 'huge.JPG'])
    expect(userContent(stored[0])).toEqual([
      { type: 'image', attachment: ref('chart.png') },
      card(uuid(2), 'gone.png'), card(uuid(3), 'bomb.png'), card(uuid(4), 'old.bmp'), card(uuid(5), 'huge.JPG'), card(uuid(6), 'report.pdf'),
      { type: 'text', text: 'Explain' },
    ])
    expect(warnings).toEqual([
      'deepseek-chat-import: conversation withdrawn was not imported: every question of the conversation was withdrawn by content filtering',
      `deepseek-chat-import: image ${gone} is not stored: not in the export`,
      `deepseek-chat-import: image ${bomb} is not stored: ${bomb} declares ${LIMITS.maxEntryBytes + 1} uncompressed bytes, more than the ${LIMITS.maxEntryBytes}-byte entry limit`,
      `deepseek-chat-import: image ${bitmap} is not stored: unsupported image type`,
      `deepseek-chat-import: image ${rejected} is not stored: image too large`,
    ])
  })

  it('does not re-scan the central directory for images', async () => {
    const images = Array.from({ length: 8 }, (_, index) => {
      const path = `chat_sessions/many_files/${uuid(index + 1)}_chart-${index}.png`
      return { path, id: uuid(index + 1), name: `chart-${index}.png` }
    })
    const conversation = withFiles('many', images.map(image => ({ id: image.id, name: image.name, path: image.path })))
    const saveImage = vi.fn((input: SaveImageAttachment) => Promise.resolve(ref(input.name ?? 'unnamed')))
    const filler = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`chat_sessions/filler-${index}.json`, '{"id":"filler"}']))
    const { run, stored } = harness({ attachments: { saveImage } })
    await run(zip(exportEntries([conversation], {
      extra: {
        ...Object.fromEntries(images.map((image, index) => [image.path, new Uint8Array([index])])),
        ...filler,
      },
    })))
    expect(stored).toHaveLength(1)
    expect(saveImage).toHaveBeenCalledTimes(8)
    // Only the manifest and the index are read by name: the images arrive in
    // the streaming image pass, so the number of central-directory scans does
    // not grow with the number of archive entries or images.
    expect(archiveReads).toEqual(['manifest.json', 'chat_session_index.json'])
  })

  it('keeps the replacement chain going when a candidate tree is invalid', async () => {
    const missingParent: ExportSessionFile = {
      id: 'missing-parent', title: 'Missing parent', inserted_at: at(0),
      messages: [{
        id: 2, parent_id: 1, role: 'USER', status: 'FINISHED', inserted_at: at(1),
        fragments: [{ type: 'REQUEST', content: 'orphan' }],
      }],
    }
    const saveImage = vi.fn((input: SaveImageAttachment) => Promise.resolve(ref(input.name ?? 'unnamed')))
    const { run, stored } = harness({ attachments: { saveImage } })
    // The image plan of a replacement conversation walks the same tree, so a
    // missing parent must fail that conversation, not the whole import.
    const result = await run(zip(exportEntries([chat('valid', 7_000)], {
      index: [indexRow('corrupt', 9_000), indexRow('missing-parent', 8_000), indexRow('valid', 7_000)],
      extra: {
        'chat_sessions/corrupt.json': '{not json',
        'chat_sessions/missing-parent.json': JSON.stringify(missingParent),
      },
    })), { maxSessions: 1 })
    expect(stored.map(titleOf)).toEqual(['title valid'])
    expect(result.skipped.map(item => item.conversationId)).toEqual(['corrupt', 'missing-parent'])
    expect(result.skipped[1]?.reason).toBe('message parent 1 does not exist')
    expect(result).toMatchObject({ conversationCount: 3, omittedByLimit: 0 })
  })
})
