/**
 * session.export host path: the GET download endpoint streams a ZIP whose
 * files are the sessions' logical logs serialized as canonical JSONL (root +
 * optional descendants) read through persistence read handles, and the
 * degenerate compositions fail loudly (missing services → 500, missing root →
 * 404, missing descendant → errored stream).
 */

import { SESSION_FORMAT_VERSION, SessionSeq } from '@deepseek-ai/dsh-session'
import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { unzipSync, strFromU8 } from 'fflate'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionLineageNode } from '@deepseek-ai/dsh-session-query'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionAccess, SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import * as SessionLogExport from '../src/index.ts'

const sid = (id: string): SessionId => id as SessionId
const exportLogName = SessionLogExport.SESSION_LOG_FILENAME
const subagentLogName = (id: string): string => `subagents/${id}/${exportLogName}`
const generationLogName = (version: number): string => version === 0
  ? 'session.jsonl'
  : `session.v${version}.jsonl`

function header(id: string, parentSession?: SessionId): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: sid(id),
    createdAt: 1000,
    isSeeded: false,
    cwd: '/proj',
    ...parentSession === undefined ? {} : { parentSession },
    delegationDepth: parentSession === undefined ? 0 : 1,
  }
}

/** One stored logical session log served by the fake persistence backend. */
interface StoredLog {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
}

const turnStart: SessionEvent = { type: 'turn/start', seq: SessionSeq(0), time: 2000, data: { turn: 1 } }

function log(id: string, parentSession?: SessionId, events: readonly SessionEvent[] = [turnStart]): StoredLog {
  return { header: header(id, parentSession), events }
}

/** The expected zip text for one stored log: the canonical JSONL serialization. */
function logText(stored: StoredLog): string {
  return SessionLogExport.serializeSessionLog(stored.header, stored.events)
}

function node(id: string, ...descendants: SessionLineageNode[]): SessionLineageNode {
  return { session: { header: header(id, sid('session-root')), live: false, persisted: true }, descendants }
}

/** One durable image object served by the fake attachment store. */
function storedImage(id: string, mediaType: ImageAttachmentRef['mediaType'] = 'image/png') {
  return {
    ref: { attachmentId: sid(id), mediaType, bytes: 4, width: 2, height: 2 } as unknown as ImageAttachmentRef,
    data: new Uint8Array([1, 2, 3, 4]),
  }
}

/** A user/message event carrying one image reference. */
function imageEvent(id: string, mediaType: ImageAttachmentRef['mediaType'] = 'image/png'): SessionEvent {
  return {
    type: 'user/message', seq: SessionSeq(1), time: 1000,
    data: { content: [{ type: 'image', attachment: { attachmentId: id, mediaType, bytes: 4, width: 2, height: 2 } }] },
  } as unknown as SessionEvent
}

/** A read handle over one stored log; only what readSessionLogText touches. */
function readHandle(stored: StoredLog): SessionHandle {
  return {
    id: stored.header.id,
    header: stored.header,
    access: 'read',
    inheritedEventCount: 0,
    read: async () => stored.events,
    close: async () => {},
  } as unknown as SessionHandle
}

async function buildApi(
  logs: Record<string, StoredLog>,
  descendants: SessionLineageNode[] = [],
  services: {
    query?: boolean
    persistence?: boolean | 'throw'
    attachments?: boolean | ((ref: ImageAttachmentRef, signal?: AbortSignal) => Promise<ReturnType<typeof storedImage>>)
    sessions?: {
      get(id: SessionId): { readonly id: SessionId } | undefined
      flush(session: { readonly id: SessionId }): Promise<boolean>
    }
    open?: (id: SessionId, access: SessionAccess, options?: { signal?: AbortSignal }) => Promise<SessionHandle>
    traceSession?: (id: SessionId, signal?: AbortSignal) => Promise<{
      target: { header: SessionHeader; live: boolean; persisted: boolean }
      ancestors: readonly SessionLineageNode[]
      complete: boolean
      root: { header: SessionHeader; live: boolean; persisted: boolean }
      descendants: readonly SessionLineageNode[]
    }>
    compressionLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
  } = {},
) {
  const ctx = new Context()
  ctx.provide('commands', { register: () => () => {} } as never)
  const query = services.query ?? true
  const persistence = services.persistence ?? true
  if (query) {
    ctx.provide('sessionQuery', {
      traceSession: services.traceSession ?? (async () => ({
        target: { header: header('session-root'), live: false, persisted: true },
        ancestors: [],
        complete: true,
        root: { header: header('session-root'), live: false, persisted: true },
        descendants,
      })),
    } as never)
  }
  if (persistence) {
    ctx.provide('sessionPersistence', {
      stat: async (id: SessionId) => {
        // A custom `open` owns the scenario: absence must reach it, not stop here.
        if (services.open !== undefined || persistence === 'throw') return { header: header(String(id)) }
        const stored = logs[id]
        return stored === undefined ? undefined : { header: stored.header }
      },
      open: services.open ?? (async (id: SessionId) => {
        if (persistence === 'throw') throw new Error('/host/private/session.jsonl')
        const stored = logs[id]
        if (stored === undefined) throw new SessionPersistenceNotFoundError(id)
        return readHandle(stored)
      }),
    } as never)
  }
  if (services.attachments !== false) {
    const readImage = typeof services.attachments === 'function'
      ? services.attachments
      : async (ref: ImageAttachmentRef) => storedImage(String(ref.attachmentId), ref.mediaType)
    ctx.provide('attachments', {
      imageLimits: {} as never,
      validateImage: async () => {},
      saveImage: async () => { throw new Error('export never saves images') },
      readImage,
    } as never)
  }
  if (services.sessions !== undefined) ctx.provide('sessions', services.sessions as never)
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  const fiber = ctx.plugin(SessionLogExport, {
    ...services.compressionLevel === undefined
      ? {}
      : { compressionLevel: services.compressionLevel },
  })
  await fiber.await()
  const handler = connection.createSharedFetchHandler('/api')
  return {
    fetch: handler,
    downloads: {
      sessionLog: (
        request: { sessionId: SessionId; includeDescendants: boolean },
        signal: AbortSignal,
      ): Promise<Response> => {
        const url = new URL(`http://host${SessionLogExport.SESSION_LOG_EXPORT_PATH}`)
        url.searchParams.set('sessionId', request.sessionId)
        url.searchParams.set('includeDescendants', String(request.includeDescendants))
        return handler.fetch(new Request(url, { signal }))
      },
    },
  }
}

function toFetchHandler(api: Awaited<ReturnType<typeof buildApi>>): { fetch(request: Request): Promise<Response> } {
  return api.fetch
}

async function responseBytes(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer())
}

/** Minimal ready services for the direct streamSessionLogZip chunking tests. */
function directReady(): SessionLogExport.SessionLogExportReady {
  return {
    sessionQuery: { traceSession: async () => { throw new Error('unused') } } as never,
    sessionPersistence: { open: async () => { throw new Error('unused') } } as never,
    attachments: { readImage: async () => { throw new Error('no media') } } as never,
    sessions: undefined,
  }
}

/** Consume one directly built zip stream into its unpacked files. */
async function directZipFiles(rootContent: string): Promise<Record<string, Uint8Array>> {
  const stream = SessionLogExport.streamSessionLogZip(
    directReady(), rootContent, sid('session-root'), false, 6, new AbortController().signal,
  )
  return unzipSync(new Uint8Array(await new Response(stream).arrayBuffer()))
}

describe('session export compression config', () => {
  it('defaults to level 6 and rejects values outside the integer 0-9 range', () => {
    expect(SessionLogExport.Config({})).toEqual({
      compressionLevel: 6,
    })
    expect(SessionLogExport.Config({ compressionLevel: 0 }))
      .toEqual({ compressionLevel: 0 })
    expect(SessionLogExport.Config({ compressionLevel: 9 }))
      .toEqual({ compressionLevel: 9 })
    for (const value of [-1, 10, 1.5]) {
      expect(() => SessionLogExport.Config({ compressionLevel: value } as never)).toThrow()
    }
  })
})

describe('serializeSessionLog', () => {
  it('uses the canonical current-generation export filename', () => {
    expect(SessionLogExport.SESSION_LOG_FILENAME).toBe(generationLogName(SESSION_FORMAT_VERSION))
  })

  it('writes the physical header line, one line per event, and a trailing newline', () => {
    const stored = log('session-root')
    expect(logText(stored)).toBe(
      `${JSON.stringify({
        type: 'session', version: SESSION_FORMAT_VERSION, id: sid('session-root'), createdAt: 1000,
        cwd: '/proj', isSeeded: false, delegationDepth: 0,
      })}\n${JSON.stringify(turnStart)}\n`,
    )
  })

  it('serializes v2 lineage through the tagged marker and defaults delegationDepth to 0', () => {
    const seeded: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: sid('seeded'),
      createdAt: 1000,
      isSeeded: true,
      parentSession: sid('parent'),
      origin: 'subagent',
      agentPreset: 'minimal',
    }
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'session/end-seed', seq: SessionSeq(2), time: 2, data: { inherited: true } },
    ]
    expect(SessionLogExport.serializeSessionLog(seeded, events)).toBe(`${JSON.stringify({
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: sid('seeded'),
      createdAt: 1000,
      parentSession: sid('parent'),
      isSeeded: true,
      origin: 'subagent',
      delegationDepth: 0,
      agentPreset: 'minimal',
    })}\n${events.map(event => JSON.stringify(event)).join('\n')}\n`)
  })
})

describe('readSessionLogText', () => {
  it('reads without a signal and maps only open not-found to undefined', async () => {
    const stored = log('session-root')
    const persistence = {
      open: async (id: SessionId) => {
        if (id !== stored.header.id) throw new SessionPersistenceNotFoundError(id)
        return readHandle(stored)
      },
    } as never
    await expect(SessionLogExport.readSessionLogText(persistence, sid('session-root')))
      .resolves.toBe(logText(stored))
    await expect(SessionLogExport.readSessionLogText(persistence, sid('absent')))
      .resolves.toBeUndefined()
  })

  it('propagates a non-not-found open failure', async () => {
    const persistence = {
      open: async () => { throw new Error('EACCES: permission denied') },
    } as never
    await expect(SessionLogExport.readSessionLogText(persistence, sid('session-root')))
      .rejects.toThrow('EACCES: permission denied')
  })
})

describe('session.export download endpoint', () => {
  it('streams a ZIP with the root log serialized as canonical JSONL', async () => {
    const stored = log('session-root')
    const api = await buildApi({ 'session-root': stored })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root'),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/zip')
    expect(response.headers.get('content-disposition')).toContain('dsh-session-session-root.zip')
    const files = unzipSync(await responseBytes(response))
    expect(Object.keys(files)).toEqual([exportLogName])
    expect(strFromU8(files[exportLogName] as Uint8Array)).toBe(logText(stored))
  })

  it('preflights root preparation through HEAD without streaming a body', async () => {
    const open = vi.fn(async () => readHandle(log('session-root')))
    const api = await buildApi({}, [], { open })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root', { method: 'HEAD' }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/zip')
    expect(response.headers.get('content-disposition')).toContain('dsh-session-session-root.zip')
    expect(response.body).toBeNull()
    expect(open).toHaveBeenCalledOnce()
  })

  it('returns a bodyless preparation error from HEAD', async () => {
    const api = await buildApi({})
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root', { method: 'HEAD' }),
    )

    expect(response.status).toBe(404)
    expect(response.body).toBeNull()
  })

  it('uses the resolved compression level for ZIP entries', async () => {
    const filler = {
      type: 'user/message', seq: SessionSeq(1), time: 1000,
      data: { content: [{ type: 'text', text: 'compressible '.repeat(32 * 1024) }] },
    } as unknown as SessionEvent
    const stored = log('session-root', undefined, [turnStart, filler])
    const storedApi = await buildApi({ 'session-root': stored }, [], { compressionLevel: 0 })
    const compressedApi = await buildApi({ 'session-root': stored }, [], { compressionLevel: 9 })
    const uncompressed = await storedApi.downloads.sessionLog(
      { sessionId: sid('session-root'), includeDescendants: false },
      new AbortController().signal,
    )
    const compressed = await compressedApi.downloads.sessionLog(
      { sessionId: sid('session-root'), includeDescendants: false },
      new AbortController().signal,
    )
    const storedBytes = await responseBytes(uncompressed)
    const compressedBytes = await responseBytes(compressed)
    expect(compressedBytes.byteLength).toBeLessThan(storedBytes.byteLength)
    expect(strFromU8(unzipSync(compressedBytes)[exportLogName] as Uint8Array)).toBe(logText(stored))
  })

  it('includes descendant logs under subagents/<id>/ when requested', async () => {
    const child = log('child-a', sid('session-root'))
    const api = await buildApi({
      'session-root': log('session-root'),
      'child-a': child,
      'grandchild-a': log('grandchild-a', sid('child-a')),
    }, [
      node('child-a', node('grandchild-a')),
    ])
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root&includeDescendants=true'),
    )
    expect(response.status).toBe(200)
    const files = unzipSync(await responseBytes(response))
    expect(Object.keys(files).sort()).toEqual([
      exportLogName,
      subagentLogName('child-a'),
      subagentLogName('grandchild-a'),
    ])
    expect(strFromU8(files[subagentLogName('child-a')] as Uint8Array))
      .toBe(logText(child))
  })

  it('flushes each live root and descendant immediately before reading its log', async () => {
    const staleMarker = { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } } as SessionEvent
    const durableMarker = { type: 'turn/start', seq: SessionSeq(0), time: 2, data: { turn: 1 } } as SessionEvent
    const stored: Record<string, StoredLog> = {
      'session-root': log('session-root', undefined, [staleMarker]),
      'child-a': log('child-a', sid('session-root'), [staleMarker]),
    }
    const durable: Record<string, StoredLog> = {
      'session-root': log('session-root', undefined, [durableMarker]),
      'child-a': log('child-a', sid('session-root'), [durableMarker]),
    }
    const flushed: SessionId[] = []
    const api = await buildApi(stored, [node('child-a')], {
      sessions: {
        get: id => durable[id] === undefined ? undefined : { id },
        flush: async (session) => {
          const logAfterFlush = durable[session.id]
          if (logAfterFlush === undefined) throw new Error('unexpected session')
          flushed.push(session.id)
          stored[session.id] = logAfterFlush
          return true
        },
      },
    })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root&includeDescendants=true'),
    )
    const files = unzipSync(await responseBytes(response))
    expect(flushed).toEqual([sid('session-root'), sid('child-a')])
    expect(strFromU8(files[exportLogName] as Uint8Array)).toBe(logText(durable['session-root'] as StoredLog))
    expect(strFromU8(files[subagentLogName('child-a')] as Uint8Array)).toBe(logText(durable['child-a'] as StoredLog))
  })

  it('reads a cold log without asking the live-session store to flush', async () => {
    const flush = vi.fn(async () => true)
    const stored = log('session-root')
    const api = await buildApi({ 'session-root': stored }, [], {
      sessions: {
        get: () => undefined,
        flush,
      },
    })
    const response = await api.downloads.sessionLog(
      { sessionId: sid('session-root'), includeDescendants: false },
      new AbortController().signal,
    )
    const files = unzipSync(await responseBytes(response))
    expect(flush).not.toHaveBeenCalled()
    expect(strFromU8(files[exportLogName] as Uint8Array)).toBe(logText(stored))
  })

  it('answers 404 for a session the backend does not store', async () => {
    const api = await buildApi({})
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root'),
    )
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('session not found')
  })

  it('answers 400 when the sessionId query parameter is absent', async () => {
    const api = await buildApi({ 'session-root': log('session-root') })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?includeDescendants=true'),
    )
    expect(response.status).toBe(400)
  })

  it('answers 400 for an includeDescendants value other than true or false', async () => {
    const api = await buildApi({ 'session-root': log('session-root') })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root&includeDescendants=1'),
    )
    expect(response.status).toBe(400)
  })

  it('answers 500 when the deployment mounts no persistence or session-query service', async () => {
    const api = await buildApi({}, [], { query: false, persistence: false })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root'),
    )
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('session-query')
  })

  it('fails the whole export when a descendant has no stored log', async () => {
    const api = await buildApi({
      'session-root': log('session-root'),
    }, [node('child-missing')])
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root&includeDescendants=true'),
    )
    expect(response.status).toBe(200)
    // The stream errors before completing, so the body read rejects rather
    // than returning a truncated-but-valid archive.
    await expect(response.arrayBuffer()).rejects.toThrow()
  })

  it('keeps an astral character whole when its surrogate pair straddles a push boundary', async () => {
    // The push loop slices by 2^16 code units and must back off one unit when
    // the boundary lands inside a surrogate pair; otherwise the pair re-encodes
    // as U+FFFD and the exported log is silently corrupted.
    const content = `${'a'.repeat((1 << 16) - 1)}😀tail`
    const files = await directZipFiles(content)
    expect(strFromU8(files[exportLogName] as Uint8Array)).toBe(content)
  })

  it('splits a long log on a plain code-unit boundary without backoff', async () => {
    // A boundary that lands on a BMP character needs no surrogate backoff; the
    // round trip must still be byte-identical across the multi-chunk push.
    const content = 'z'.repeat((1 << 16) + 4096)
    const files = await directZipFiles(content)
    expect(strFromU8(files[exportLogName] as Uint8Array)).toBe(content)
  })

  it('streams an empty root text as an empty zip entry', async () => {
    const files = await directZipFiles('')
    expect(Object.keys(files)).toEqual([exportLogName])
    expect(strFromU8(files[exportLogName] as Uint8Array)).toBe('')
  })

  it('waits for response pull capacity before reading the next archive entry', async () => {
    const filler = {
      type: 'user/message', seq: SessionSeq(2), time: 1000,
      data: { content: [{ type: 'text', text: randomBytes(512 * 1024).toString('base64') }] },
    } as unknown as SessionEvent
    const stored = log('session-root', undefined, [imageEvent('after-root'), filler])
    let imageReads = 0
    const api = await buildApi({ 'session-root': stored }, [], {
      attachments: async (ref) => {
        imageReads += 1
        return storedImage(String(ref.attachmentId), ref.mediaType)
      },
    })
    vi.useFakeTimers()
    let response: Response | undefined
    try {
      response = await toFetchHandler(api).fetch(
        new Request('http://host/api/session.export?sessionId=session-root'),
      )
      // Exhausting timer turns must not advance a producer whose byte queue is
      // full; only a consumer pull can release it.
      await vi.runAllTimersAsync()
      expect(imageReads).toBe(0)
    } finally {
      vi.useRealTimers()
    }
    if (response === undefined) throw new Error('missing export response')
    const files = unzipSync(await responseBytes(response))
    expect(imageReads).toBe(1)
    expect(files['media/after-root.png']).toEqual(storedImage('after-root').data)
  })

  it('exports a shared lineage node once (seen-set dedup)', async () => {
    const api = await buildApi({
      'session-root': log('session-root'),
      'child-a': log('child-a', sid('session-root')),
      'child-b': log('child-b', sid('session-root')),
      shared: log('shared', sid('child-a')),
    }, [
      node('child-a', node('shared')),
      node('child-b', node('shared')),
    ])
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root&includeDescendants=true'),
    )
    const files = unzipSync(await responseBytes(response))
    expect(Object.keys(files).sort()).toEqual([
      exportLogName,
      subagentLogName('child-a'),
      subagentLogName('child-b'),
      subagentLogName('shared'),
    ])
  })

  it('answers 500 without leaking the backend error when the root read fails', async () => {
    const api = await buildApi({}, [], { query: true, persistence: 'throw' })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root'),
    )
    expect(response.status).toBe(500)
    const body = await response.text()
    expect(body).toBe('session log export failed to read the stored log')
    expect(body).not.toContain('/host/private/')
  })

  it('answers the private-error-safe 500 when the live root flush fails', async () => {
    const api = await buildApi({ 'session-root': log('session-root') }, [], {
      sessions: {
        get: id => ({ id }),
        flush: async () => { throw new Error('/host/private/flush-state') },
      },
    })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root'),
    )
    expect(response.status).toBe(500)
    const body = await response.text()
    expect(body).toBe('session log export failed to read the stored log')
    expect(body).not.toContain('/host/private/')
  })

  it('forwards one request signal through root, lineage, and descendant reads', async () => {
    const reads: Array<{ id: SessionId; signal: AbortSignal | undefined }> = []
    const traces: AbortSignal[] = []
    const api = await buildApi({}, [node('child-a')], {
      open: async (id, _access, options) => {
        reads.push({ id, signal: options?.signal })
        return readHandle(id === sid('session-root')
          ? log('session-root')
          : log('child-a', sid('session-root')))
      },
      traceSession: async (_id, signal) => {
        if (signal !== undefined) traces.push(signal)
        return {
          target: { header: header('session-root'), live: false, persisted: true },
          ancestors: [],
          complete: true,
          root: { header: header('session-root'), live: false, persisted: true },
          descendants: [node('child-a')],
        }
      },
    })
    const controller = new AbortController()
    const response = await api.downloads.sessionLog(
      { sessionId: sid('session-root'), includeDescendants: true },
      controller.signal,
    )
    await response.arrayBuffer()
    const rootSignal = reads[0]?.signal
    if (rootSignal === undefined) throw new Error('missing root signal')
    const producerSignal = traces[0]
    if (producerSignal === undefined) throw new Error('missing lineage signal')
    expect(reads[0]?.id).toBe(sid('session-root'))
    expect(reads[1]).toEqual({ id: sid('child-a'), signal: producerSignal })
    const cancellation = new Error('request cancelled after response')
    controller.abort(cancellation)
    expect(rootSignal.aborted).toBe(true)
    expect(rootSignal.reason).toBe(cancellation)
    expect(producerSignal.aborted).toBe(true)
    expect(producerSignal.reason).toBe(cancellation)
  })

  it('preserves request cancellation instead of translating it to HTTP 500', async () => {
    const api = await buildApi({ 'session-root': log('session-root') })
    const controller = new AbortController()
    const cancellation = new Error('request cancelled')
    controller.abort(cancellation)
    await expect(api.downloads.sessionLog(
      { sessionId: sid('session-root'), includeDescendants: false },
      controller.signal,
    )).rejects.toBe(cancellation)
  })

  it('aborts descendant work and terminates ZIP production when its reader cancels', async () => {
    let reportDescendantStarted!: (signal: AbortSignal) => void
    const descendantStarted = new Promise<AbortSignal>((resolve) => {
      reportDescendantStarted = resolve
    })
    const api = await buildApi({}, [node('child-a')], {
      open: async (id, _access, options) => {
        if (id === sid('session-root')) return readHandle(log('session-root'))
        const signal = options?.signal
        if (signal === undefined) throw new Error('missing descendant signal')
        reportDescendantStarted(signal)
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(signal.reason as Error)
          }, { once: true })
        })
      },
    })
    const response = await api.downloads.sessionLog(
      { sessionId: sid('session-root'), includeDescendants: true },
      new AbortController().signal,
    )
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('missing response body')
    const descendantSignal = await descendantStarted
    const cancellation = new Error('download consumer left')
    await reader.cancel(cancellation)
    expect(descendantSignal.aborted).toBe(true)
    expect(descendantSignal.reason).toBe(cancellation)
  })

  it('aborts attachment reads when its reader cancels', async () => {
    let reportAttachmentStarted!: (signal: AbortSignal) => void
    const attachmentStarted = new Promise<AbortSignal>((resolve) => {
      reportAttachmentStarted = resolve
    })
    const stored = log('session-root', undefined, [imageEvent('slow-img')])
    const api = await buildApi({ 'session-root': stored }, [], {
      attachments: async (_ref, signal) => {
        if (signal === undefined) throw new Error('missing attachment signal')
        reportAttachmentStarted(signal)
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(signal.reason as Error)
          }, { once: true })
        })
      },
    })
    const response = await api.downloads.sessionLog(
      { sessionId: sid('session-root'), includeDescendants: false },
      new AbortController().signal,
    )
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('missing response body')
    const attachmentSignal = await attachmentStarted
    const cancellation = new Error('download consumer left during attachment read')
    await reader.cancel(cancellation)
    expect(attachmentSignal.aborted).toBe(true)
    expect(attachmentSignal.reason).toBe(cancellation)
  })

  it('uses a stable Error reason when its reader cancels without one', async () => {
    let reportDescendantStarted!: (signal: AbortSignal) => void
    const descendantStarted = new Promise<AbortSignal>((resolve) => {
      reportDescendantStarted = resolve
    })
    const api = await buildApi({}, [node('child-a')], {
      open: async (id, _access, options) => {
        if (id === sid('session-root')) return readHandle(log('session-root'))
        const signal = options?.signal
        if (signal === undefined) throw new Error('missing descendant signal')
        reportDescendantStarted(signal)
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(signal.reason as Error)
          }, { once: true })
        })
      },
    })
    const response = await api.downloads.sessionLog(
      { sessionId: sid('session-root'), includeDescendants: true },
      new AbortController().signal,
    )
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('missing response body')
    const descendantSignal = await descendantStarted
    await reader.cancel()
    expect(descendantSignal.reason).toEqual(new Error('session log export stream cancelled'))
  })

  it('normalizes a non-Error descendant failure before erroring the stream', async () => {
    const api = await buildApi({}, [node('child-a')], {
      open: async (id) => {
        if (id === sid('session-root')) return readHandle(log('session-root'))
        throw 'descendant read failed'
      },
    })
    const response = await api.downloads.sessionLog(
      { sessionId: sid('session-root'), includeDescendants: true },
      new AbortController().signal,
    )
    await expect(response.arrayBuffer()).rejects.toEqual(new Error('descendant read failed'))
  })

  it('includes media objects referenced by the root log under media/<id>.<ext>', async () => {
    const stored = log('session-root', undefined, [imageEvent('img-1')])
    const api = await buildApi({ 'session-root': stored })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root'),
    )
    expect(response.status).toBe(200)
    const files = unzipSync(await responseBytes(response))
    expect(Object.keys(files).sort()).toEqual(['media/img-1.png', exportLogName].sort())
    expect(files['media/img-1.png']).toEqual(storedImage('img-1').data)
  })

  it('collects media referenced from nested tool results', async () => {
    const nested = {
      type: 'assistant/message', seq: SessionSeq(2), time: 2000,
      data: { content: [{ type: 'tool-result', content: [{ type: 'image', attachment: { attachmentId: 'nested-1', mediaType: 'image/webp', bytes: 4, width: 2, height: 2 } }] }] },
    } as unknown as SessionEvent
    const api = await buildApi({ 'session-root': log('session-root', undefined, [nested]) })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root'),
    )
    const files = unzipSync(await responseBytes(response))
    expect(Object.keys(files).sort()).toEqual(['media/nested-1.webp', exportLogName].sort())
  })

  it('scans wrapped, inserted, and embedded-stream carriers plus non-object content items', async () => {
    const block = (id: string, mediaType: string): unknown =>
      ({ type: 'image', attachment: { attachmentId: id, mediaType, bytes: 4, width: 2, height: 2 } })
    const wrapped = {
      type: 'assistant/message', seq: SessionSeq(2), time: 2000,
      data: { message: { role: 'assistant', content: ['noise', block('wrapped-1', 'image/jpeg')] } },
    } as unknown as SessionEvent
    const inserted = {
      type: 'context/inserted', seq: SessionSeq(3), time: 3000,
      data: { inserted: [{ content: [block('inserted-1', 'image/gif')] }] },
    } as unknown as SessionEvent
    const attempt = {
      type: 'assistant/attempt', seq: SessionSeq(4), time: 4000,
      data: {
        stream: [
          { type: 'text-chunks', time0: 3999, index: 0, dt: [], texts: ['ignored'] },
          { type: 'chunk', time: 4000, chunk: { type: 'finish', reason: { kind: 'stop' } } },
          {
            type: 'chunk', time: 4000,
            chunk: { type: 'block-end', block: block('stream-1', 'image/png') },
          },
        ],
      },
    } as unknown as SessionEvent
    const api = await buildApi({ 'session-root': log('session-root', undefined, [wrapped, inserted, attempt]) })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root'),
    )
    const files = unzipSync(await responseBytes(response))
    expect(Object.keys(files).sort()).toEqual([
      'media/inserted-1.gif',
      'media/stream-1.png',
      'media/wrapped-1.jpg',
      exportLogName,
    ])
  })

  it('deduplicates one media object referenced by several included logs', async () => {
    const root = log('session-root', undefined, [imageEvent('shared-img')])
    const child = log('child-a', sid('session-root'), [imageEvent('shared-img')])
    const api = await buildApi({ 'session-root': root, 'child-a': child }, [node('child-a')])
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root&includeDescendants=true'),
    )
    const files = unzipSync(await responseBytes(response))
    expect(files['media/shared-img.png']).toEqual(storedImage('shared-img').data)
    expect(Object.keys(files).filter(name => name.startsWith('media/'))).toEqual(['media/shared-img.png'])
  })

  it('includes descendant media only when descendants are requested', async () => {
    const child = log('child-a', sid('session-root'), [imageEvent('child-img')])
    const api = await buildApi({ 'session-root': log('session-root'), 'child-a': child }, [node('child-a')])
    const without = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root'),
    )
    expect(Object.keys(unzipSync(await responseBytes(without)))).toEqual([exportLogName])
    const withDescendants = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root&includeDescendants=true'),
    )
    expect(Object.keys(unzipSync(await responseBytes(withDescendants))).sort()).toEqual([
      'media/child-img.png',
      exportLogName,
      subagentLogName('child-a'),
    ])
  })

  it('fails the whole export when a referenced image cannot be read', async () => {
    const stored = log('session-root', undefined, [imageEvent('gone-img')])
    const api = await buildApi({ 'session-root': stored }, [], {
      attachments: async () => { throw new Error('attachment bytes missing') },
    })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root'),
    )
    expect(response.status).toBe(200)
    await expect(response.arrayBuffer()).rejects.toThrow('attachment bytes missing')
  })

  it('answers 500 when the deployment mounts no attachments service', async () => {
    const api = await buildApi({ 'session-root': log('session-root') }, [], { attachments: false })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?sessionId=session-root'),
    )
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('attachments')
  })
})
