/**
 * OTel backend unit tier: wire assertions against a scripted `node:http`
 * mock collector through the SDK's REAL pipeline (BatchLogRecordProcessor →
 * OTLP/HTTP JSON), config fail-loud cases, and the real-Loader-path guard
 * for the default-exported Service class.
 */

import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { recordFeedback } from '@deepseek-ai/dsh-command-feedback'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import MessageFeedbackService from '@deepseek-ai/dsh-message-feedback'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import OpenTelemetrySessionBackend, { Config, DEFAULT_TELEMETRY_MODE, SessionTelemetryMode } from '../src/index.ts'

interface Capture {
  headers: import('node:http').IncomingHttpHeaders
  body: OtlpLogsRequest
}

/** Just the slice of ExportLogsServiceRequest JSON these assertions touch. */
interface OtlpLogsRequest {
  resourceLogs: {
    resource: { attributes: { key: string; value: { stringValue?: string } }[] }
    scopeLogs: {
      scope: { name: string }
      logRecords: {
        timeUnixNano: string
        severityNumber: number
        severityText: string
        attributes?: { key: string; value: Record<string, unknown> }[]
        body?: unknown
      }[]
    }[]
  }[]
}

const servers: Server[] = []

// The backend resolves the harness home's anonymous user id at construction;
// pin DSH_HOME to a temp dir so the suite never touches the ambient ~/.dsh.
let tempHome: string
let previousDshHome: string | undefined
beforeAll(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'dsh-otel-home-'))
  previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = tempHome
})
afterAll(() => {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  rmSync(tempHome, { recursive: true, force: true })
})

afterEach(async () => {
  for (const server of servers.splice(0)) {
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closed
  }
})

async function mockCollector(
  beforeRespond?: (requestIndex: number) => Promise<void> | void,
): Promise<{ url: string; captures: Capture[] }> {
  const captures: Capture[] = []
  let requestIndex = 0
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk as Buffer))
    request.on('end', () => {
      const index = requestIndex++
      void (async () => {
        await beforeRespond?.(index)
        const raw = Buffer.concat(chunks)
        const body = request.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw
        captures.push({
          headers: request.headers,
          body: JSON.parse(body.toString()) as OtlpLogsRequest,
        })
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      })()
    })
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}/v1/logs`, captures }
}

async function boot(url: string) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(OpenTelemetrySessionBackend, {
    mode: SessionTelemetryMode.FEEDBACK_ONLY,
    exporter: { url, headers: { authorization: 'Bearer test-token' } },
  })
  return { ctx, fiber }
}

function allRecords(captures: Capture[]) {
  return captures.flatMap(c => c.body.resourceLogs.flatMap(r => r.scopeLogs.flatMap(s =>
    s.logRecords.map(record => ({ scope: s.scope.name, record })))))
}

function eventTypes(captures: Capture[]): string[] {
  return allRecords(captures).flatMap(({ record }) =>
    record.attributes?.flatMap(attribute =>
      attribute.key === 'event.type' && typeof attribute.value['stringValue'] === 'string'
        ? [attribute.value['stringValue']]
        : []) ?? [])
}

describe('OpenTelemetrySessionBackend wire', () => {
  it('ships only the submitted prefix through the real SDK pipeline', async () => {
    const { url, captures } = await mockCollector()
    const { ctx, fiber } = await boot(url)
    const session = ctx.sessions.create(SessionId('wire'), { meta: { cwd: '/tmp/w' } })
    session.append('request/header', { header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' })
    session.append('turn/start', { turn: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'first complete chunksecond complete chunk' }],
        source: { provider: 'mock', model: 'mock' },
      }),
      stream: [
        {
          type: 'text-chunks',
          time0: 1_000,
          index: 0,
          dt: [7],
          texts: ['first complete chunk', 'second complete chunk'],
        },
        { type: 'chunk', time: 1_007, chunk: { type: 'finish', reason: { kind: 'stop' } } },
      ],
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } } })
    ctx.sessionTelemetry.emit({
      channel: 'ledger',
      time: Date.now(),
      severity: 'info',
      attributes: { 'session.id': 'wire', 'event.type': 'manual', 'event.seq': 99 },
      body: { direct: true },
    })
    recordFeedback(session, 'explicit report')
    await fiber.dispose()

    expect(captures.length).toBeGreaterThan(0)
    const first = captures[0]!
    const authorization: string | undefined = first.headers.authorization
    expect(authorization).toBe('Bearer test-token')

    const resource = first.body.resourceLogs[0]!.resource.attributes
    expect(resource).toContainEqual({ key: 'service.name', value: { stringValue: 'deepseek-harness' } })
    expect(resource).toContainEqual({ key: 'user.id', value: { stringValue: getOrCreateAnonymousUserId() } })

    const records = allRecords(captures)
    const ledger = records.filter(r => r.scope === '@deepseek-ai/dsh-session-telemetry-otel')
    const ops = records.filter(r => r.scope === '@deepseek-ai/dsh-session-telemetry-otel/ops')

    const start = ledger.find(r => r.record.attributes?.some(a => a.key === 'event.type' && a.value.stringValue === 'turn/start'))
    expect(start).toBeDefined()
    expect(start?.record.severityNumber).toBe(9)
    expect(BigInt(start!.record.timeUnixNano)).toBe(BigInt(session.snapshotEvents().find(event => event.type === 'turn/start')!.time) * 1_000_000n)
    expect(start?.record.attributes).toContainEqual({
      key: 'session.format_version',
      value: { intValue: SESSION_FORMAT_VERSION },
    })
    expect(start?.record.attributes).toContainEqual({ key: 'session.cwd', value: { stringValue: '/tmp/w' } })

    const end = ledger.find(r => r.record.attributes?.some(a => a.key === 'event.type' && a.value.stringValue === 'turn/end'))
    expect(end?.record.severityNumber).toBe(17)
    expect(end?.record.severityText).toBe('ERROR')
    const assistant = ledger.find(r =>
      r.record.attributes?.some(a => a.key === 'event.type' && a.value.stringValue === 'assistant/message'))
    const body = assistant?.record.body as {
      kvlistValue: { values: { key: string; value: unknown }[] }
    }
    expect(body.kvlistValue.values.find(value => value.key === 'stream')?.value).toEqual({
      arrayValue: {
        values: [
          {
            kvlistValue: {
              values: [
                { key: 'type', value: { stringValue: 'text-chunks' } },
                { key: 'time0', value: { intValue: 1_000 } },
                { key: 'index', value: { intValue: 0 } },
                { key: 'dt', value: { arrayValue: { values: [{ intValue: 7 }] } } },
                {
                  key: 'texts',
                  value: {
                    arrayValue: {
                      values: [
                        { stringValue: 'first complete chunk' },
                        { stringValue: 'second complete chunk' },
                      ],
                    },
                  },
                },
              ],
            },
          },
          {
            kvlistValue: {
              values: [
                { key: 'type', value: { stringValue: 'chunk' } },
                { key: 'time', value: { intValue: 1_007 } },
                {
                  key: 'chunk',
                  value: {
                    kvlistValue: {
                      values: [
                        { key: 'type', value: { stringValue: 'finish' } },
                        {
                          key: 'reason',
                          value: { kvlistValue: { values: [{ key: 'kind', value: { stringValue: 'stop' } }] } },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    })
    expect(eventTypes(captures)).not.toContain('manual')
    expect(eventTypes(captures)).toEqual(session.snapshotEvents().map(event => event.type))
    expect(ops).toHaveLength(0)
  })

  it('drains records enqueued after a timer export began: dispose during an in-flight batch', async () => {
    // Hold the first authorized batch while a second submission queues its suffix.
    const gate = Promise.withResolvers<boolean>()
    const arrived = Promise.withResolvers<boolean>()
    const { url, captures } = await mockCollector(async (index) => {
      if (index === 0) {
        arrived.resolve(true)
        await gate.promise
      }
    })
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(OpenTelemetrySessionBackend, {
      mode: SessionTelemetryMode.FEEDBACK_ONLY,
      exporter: { url },
      processor: { scheduledDelayMillis: 10 },
    })
    const session = ctx.sessions.create(SessionId('drain'), { meta: {} })
    session.append('request/header', { header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' })
    session.append('turn/start', { turn: 1 })
    recordFeedback(session, 'first report')
    await arrived.promise

    recordFeedback(session, 'second report')
    session.append('turn/start', { turn: 2 })
    const shutdown = vi.spyOn(ctx.sessionTelemetry, 'shutdown')
    const disposal = fiber.dispose()
    await expect.poll(() => shutdown.mock.calls.length).toBe(1)
    gate.resolve(true)
    await disposal

    expect(eventTypes(captures)).toEqual(['request/header', 'turn/start', 'feedback/record', 'feedback/record'])
    expect(JSON.stringify(captures)).toContain('second report')
    expect(allRecords(captures).some(r => r.scope.endsWith('/ops'))).toBe(false)
  })

  it('bounds the SDK forceFlush wait when an in-flight transport never settles', async () => {
    const gate = Promise.withResolvers<boolean>()
    const arrived = Promise.withResolvers<boolean>()
    const { url, captures } = await mockCollector(async (index) => {
      if (index === 0) {
        arrived.resolve(true)
        await gate.promise
      }
    })
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(OpenTelemetrySessionBackend, {
      mode: SessionTelemetryMode.FEEDBACK_ONLY,
      exporter: { url, timeoutMillis: 60_000 },
      processor: { scheduledDelayMillis: 10, exportTimeoutMillis: 60_000 },
      shutdownTimeoutMillis: 50,
    })
    const session = ctx.sessions.create(SessionId('bounded-shutdown'), { meta: {} })
    session.append('request/header', { header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' })
    session.append('turn/start', { turn: 1 })
    recordFeedback(session, 'first report')
    await arrived.promise

    recordFeedback(session, 'second report')
    const started = performance.now()
    await fiber.dispose()
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(captures).toHaveLength(0)

    // The outer deadline cannot cancel the SDK transport. Let it finish so
    // the real provider promise remains clean after the test has proved the
    // Cordis disposer no longer waits for it.
    gate.resolve(true)
    await expect.poll(() => captures.length).toBeGreaterThanOrEqual(2)
  })

  it('passes exporter options beyond url and headers through to the SDK exporter', async () => {
    const { url, captures } = await mockCollector()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    // `compression` is a documented SDK exporter option; the advertised
    // verbatim passthrough must hand it (and every other field) to the
    // exporter rather than silently rebuilding url/headers only.
    const fiber = await ctx.plugin(OpenTelemetrySessionBackend, {
      mode: SessionTelemetryMode.FEEDBACK_ONLY,
      exporter: { url, compression: 'gzip' },
    } as Config)
    const session = ctx.sessions.create(SessionId('gzip'), { meta: {} })
    session.append('request/header', { header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' })
    session.append('turn/start', { turn: 1 })
    recordFeedback(session, 'compressed report')
    await fiber.dispose()

    expect(captures.length).toBeGreaterThan(0)
    expect(captures[0]!.headers['content-encoding']).toBe('gzip')
    const types = allRecords(captures).flatMap(({ record }) =>
      record.attributes?.flatMap(a => a.key === 'event.type' ? [a.value.stringValue] : []) ?? [])
    expect(types).toContain('turn/start')
  })

  it('maps warn severity from record policy and leaves the seam flush hint unimplemented', async () => {
    const { url, captures } = await mockCollector()
    const { ctx, fiber } = await boot(url)
    ctx.on('session-telemetry/record', (_record, next) => ({ ...next(), severity: 'warn' }))
    const session = ctx.sessions.create(SessionId('warn'), { meta: {} })
    session.append('request/header', { header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' })
    session.append('turn/start', { turn: 1 })
    // No flush(): the coordinator's optional-call forwarding no-ops, and the
    // batch processor owns export cadence end to end (see the backend note).
    expect('flush' in ctx.sessionTelemetry && ctx.sessionTelemetry.flush !== undefined).toBe(false)
    recordFeedback(session, 'warning feedback')
    await fiber.dispose()
    const start = allRecords(captures).find(r =>
      r.record.attributes?.some(a => a.key === 'event.type' && a.value.stringValue === 'turn/start'))
    expect(start?.record.severityNumber).toBe(13)
  })

  it('replays each session suffix only at the next feedback event', async () => {
    const { url, captures } = await mockCollector()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(OpenTelemetrySessionBackend, {
      mode: SessionTelemetryMode.FEEDBACK_ONLY,
      exporter: { url },
    })
    ctx.on('session-telemetry/record', (_record, next) => {
      ctx.sessionTelemetry.emit({
        channel: 'ledger',
        time: Date.now(),
        severity: 'info',
        attributes: { 'session.id': 'feedback-only', 'event.type': 'direct-bypass', 'event.seq': 99 },
        body: { mustStayLocal: true },
      })
      return next()
    })
    const session = ctx.sessions.create(SessionId('feedback-only'), { meta: {} })
    session.append('request/header', { header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' })
    session.append('turn/start', { turn: 1 })
    recordFeedback(session, 'first report')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    recordFeedback(session, 'second report')
    session.append('turn/start', { turn: 2 })
    await fiber.dispose()

    const types = allRecords(captures).flatMap(({ record }) =>
      record.attributes?.flatMap(attribute =>
        attribute.key === 'event.type' ? [attribute.value.stringValue] : []) ?? [])
    expect(types).toEqual(['request/header', 'turn/start', 'feedback/record', 'turn/end', 'feedback/record'])
    expect(JSON.stringify(captures)).toContain('first report')
    expect(JSON.stringify(captures)).toContain('second report')
    expect(allRecords(captures).some(({ scope }) => scope.endsWith('/ops'))).toBe(false)
  })

  it('ignores direct emits and non-canonical feedback in feedback-only mode', async () => {
    const { url, captures } = await mockCollector()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const fiber = await ctx.plugin(OpenTelemetrySessionBackend, {
      mode: SessionTelemetryMode.FEEDBACK_ONLY,
      exporter: { url },
    })
    const session = ctx.sessions.create(SessionId('no-feedback'), { meta: {} })
    session.append('request/header', { header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' })
    session.append('turn/start', { turn: 1 })
    ctx.sessionTelemetry.emit({
      channel: 'ledger',
      time: Date.now(),
      severity: 'info',
      attributes: { 'session.id': 'no-feedback', 'event.type': 'direct', 'event.seq': 99 },
      body: { mustStayLocal: true },
    })
    const envelope = { seq: SessionSeq(session.seq), time: Date.now() }
    ctx.emit('session/event', session, { ...envelope, type: 'feedback/record', data: { text: 'not committed' } })
    await fiber.dispose()

    expect(warn).toHaveBeenCalledWith(
      'session telemetry ignored an event absent from the canonical session log',
    )
    expect(captures).toEqual([])
  })

  it('constructs no disabled transport even when exporter options are present', async () => {
    const { url, captures } = await mockCollector()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const fiber = await ctx.plugin(OpenTelemetrySessionBackend, {
      mode: SessionTelemetryMode.DISABLED,
      exporter: { url },
      processor: { maxExportBatchSize: 0 },
    })
    const session = ctx.sessions.create(SessionId('disabled'), { meta: {} })
    session.append('request/header', { header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' })
    session.append('turn/start', { turn: 1 })
    recordFeedback(session, 'local report')

    expect(warn).toHaveBeenCalledWith(
      'OpenTelemetry session upload is DISABLED; this feedback is not uploaded through OpenTelemetry',
    )
    ctx.sessionTelemetry.emit({
      channel: 'ledger',
      time: 0,
      severity: 'info',
      attributes: {},
      body: null,
    })
    await ctx.sessionTelemetry.shutdown()
    await fiber.dispose()
    recordFeedback(session, 'after disposal')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(captures).toEqual([])
  })

  it('discloses the sharing policy for every mode', async () => {
    const { url, captures } = await mockCollector()

    const gatedCtx = new Context()
    await gatedCtx.plugin(SessionStore)
    const gated = await gatedCtx.plugin(OpenTelemetrySessionBackend, { mode: SessionTelemetryMode.FEEDBACK_ONLY, exporter: { url } })
    expect(gatedCtx.sessionTelemetry.sharing).toBe('feedback-only')
    await gated.dispose()

    const disabledCtx = new Context()
    await disabledCtx.plugin(SessionStore)
    const disabled = await disabledCtx.plugin(OpenTelemetrySessionBackend, { mode: SessionTelemetryMode.DISABLED })
    expect(disabledCtx.sessionTelemetry.sharing).toBe('disabled')
    await disabled.dispose()

    const defaultCtx = new Context()
    await defaultCtx.plugin(SessionStore)
    const defaulted = await defaultCtx.plugin(OpenTelemetrySessionBackend, { exporter: { url } })
    expect(defaultCtx.sessionTelemetry.sharing).toBe('feedback-only')
    await defaulted.dispose()

    // No record was emitted by any mode, so nothing reached the collector.
    expect(captures).toEqual([])
  })

  it('defaults direct construction to feedback-only delivery', async () => {
    const { url, captures } = await mockCollector()
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      new OpenTelemetrySessionBackend(ctx, {
        exporter: { url },
        processor: { scheduledDelayMillis: 1 },
      })
      const session = ctx.sessions.create(SessionId('direct-default'), { meta: {} })
      session.append('request/header', { header: { config: { provider: 'deepseek-official', model: 'mock' } }, reason: 'initial' })
      session.append('turn/start', { turn: 1 })
      expect(captures).toEqual([])
      recordFeedback(session, 'explicit report')
      const submitted = session.snapshotEvents().map(event => event.type)
      await expect.poll(() => eventTypes(captures)).toEqual(submitted)
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await ctx.sessionTelemetry.shutdown()
      expect(eventTypes(captures)).toEqual(submitted)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('OpenTelemetrySessionBackend route and feedback', () => {
  it.each(['deepseek-official', 'mock', undefined])('uploads new text feedback for %s while the host stays alive', async (provider) => {
    const { url, captures } = await mockCollector()
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(OpenTelemetrySessionBackend, {
        mode: SessionTelemetryMode.FEEDBACK_ONLY, exporter: { url }, processor: { scheduledDelayMillis: 1 },
      })
      const session = ctx.sessions.create(SessionId('text-feedback'))
      if (provider !== undefined) session.append('request/header', { header: { config: { provider, model: 'm' } }, reason: 'initial' })
      session.append('turn/start', { turn: 1 })
      expect(captures).toEqual([])
      recordFeedback(session, 'explicit report')
      const expected = session.snapshotEvents().map(event => event.type)
      await expect.poll(() => eventTypes(captures)).toEqual(expected)
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      session.append('request/header', { header: { config: { provider: 'deepseek-official', model: 'm' } }, reason: 'change' })
      await ctx.sessionTelemetry.shutdown()
      expect(eventTypes(captures)).toEqual(expected)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not upload ordinary events, inherited feedback, new/open/resume/fork or HMR', async () => {
    const { url, captures } = await mockCollector()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const donor = Session.create(SessionId('stored-feedback'))
    recordFeedback(donor, 'old feedback is not a submission')
    const restored = ctx.sessions.create(donor.id, { seed: donor.snapshotEvents(), meta: donor.header })
    try {
      const first = await ctx.plugin(OpenTelemetrySessionBackend, { mode: SessionTelemetryMode.FEEDBACK_ONLY, exporter: { url } })
      const session = ctx.sessions.create(SessionId('ordinary'))
      session.append('turn/start', { turn: 1 })
      for (const provider of ['mock', 'deepseek-official']) {
        session.append('model/selection', { provider, model: 'm' })
        session.append('request/header', { header: { config: { provider, model: 'm' } }, reason: 'change' })
      }
      const child = ctx.sessions.fork(restored, undefined, SessionId('child'))
      const inherited = child.snapshotEvents().find(event => event.type === 'feedback/record')!
      ctx.emit('session/event', child, inherited)
      const opened = ctx.sessions.create(SessionId('opened'), { seed: donor.snapshotEvents() })
      ctx.emit('session/created', opened)
      await first.dispose()
      await ctx.plugin(OpenTelemetrySessionBackend, { mode: SessionTelemetryMode.FEEDBACK_ONLY, exporter: { url } })
    } finally {
      await ctx.fiber.dispose()
    }
    expect(captures).toEqual([])
  })

  it.each(['deepseek-official', 'mock', undefined])('uploads live ratings, notes and withdrawal for %s without further interaction', async (provider) => {
    const { url, captures } = await mockCollector()
    const root = mkdtempSync(join(tmpdir(), 'dsh-otel-live-'))
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
      await ctx.plugin(MessageFeedbackService, { maxNoteBytes: 1024 })
      await ctx.plugin(OpenTelemetrySessionBackend, {
        mode: SessionTelemetryMode.FEEDBACK_ONLY, exporter: { url }, processor: { scheduledDelayMillis: 1 },
      })
      const session = ctx.sessions.create(SessionId('live-ratings'))
      const handle = await ctx.sessionPersistence.create(session.header)
      try {
        if (provider !== undefined) session.append('request/header', { header: { config: { provider, model: 'm' } }, reason: 'initial' })
        const message = createAssistantMessage({ content: [{ type: 'text', text: 'answer' }], source: { provider: provider ?? 'mock', model: 'm' } })
        session.append('assistant/message', { message, stream: [], turn: 1, step: 1 }, { surfaceOp: 'append' })
        const request = { sessionId: session.id, messageId: message.id, rating: 'positive' as const, ifVersion: null }
        const before = session.seq
        expect((await ctx.messageFeedback.put({ ...request, note: ' ' })).ok).toBe(false)
        expect(session.seq).toBe(before)
        expect(captures).toEqual([])
        const put = await ctx.messageFeedback.put(request)
        if (!put.ok) throw new Error('live put failed')
        await expect.poll(() => eventTypes(captures)).toEqual(session.snapshotEvents().map(event => event.type))
        const throughPut = session.seq
        await ctx.messageFeedback.put({ ...request, ifVersion: put.value.version })
        expect((await ctx.messageFeedback.put(request)).ok).toBe(false)
        expect(session.seq).toBe(throughPut)
        const edit = await ctx.messageFeedback.put({ ...request, ifVersion: put.value.version, note: 'edited note' })
        if (!edit.ok) throw new Error('live note failed')
        await expect.poll(() => eventTypes(captures)).toEqual(session.snapshotEvents().map(event => event.type))
        await ctx.messageFeedback.delete({ sessionId: session.id, messageId: message.id, ifVersion: edit.value.version })
        await expect.poll(() => eventTypes(captures)).toEqual(session.snapshotEvents().map(event => event.type))
        const submitted = eventTypes(captures)
        const throughDelete = session.seq
        await ctx.messageFeedback.delete({ sessionId: session.id, messageId: message.id, ifVersion: edit.value.version })
        expect(session.seq).toBe(throughDelete)
        session.append('turn/start', { turn: 2 })
        await ctx.sessionTelemetry.shutdown()
        expect(eventTypes(captures)).toEqual(submitted)
      } finally {
        await handle.close()
      }
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores cold snapshots without a last own feedback event and foreign live ratings', async () => {
    const { url, captures } = await mockCollector()
    const { ctx, fiber } = await boot(url)
    const session = Session.create(SessionId('cold-not-submitted'))
    const notify = async () => ctx.parallel('feedback/committed', {
      meta: session.header, events: session.snapshotEvents(), inheritedEventCount: session.inheritedEventCount,
    })
    await notify()
    recordFeedback(session, 'older feedback')
    session.append('turn/start', { turn: 1 })
    await notify()
    const child = ctx.sessions.create(SessionId('foreign'))
    const message = createAssistantMessage({ content: [], source: { provider: 'mock', model: 'm' } })
    child.append('feedback/message-delete', { sessionId: session.id, messageId: message.id })
    await ctx.parallel('feedback/committed', {
      meta: { ...session.header, id: SessionId('inherited-cold'), parentSession: session.id, isSeeded: true },
      events: session.snapshotEvents(SessionLogOffset(0), SessionLogOffset(1)), inheritedEventCount: SessionLogOffset(1),
    })
    await fiber.dispose()
    expect(captures).toEqual([])
  })

  it.each([SessionTelemetryMode.FEEDBACK_ONLY])('restores a cold fork with its exact inherited cut in %s', async (mode) => {
    const { url, captures } = await mockCollector()
    const root = mkdtempSync(join(tmpdir(), 'dsh-otel-cold-fork-'))
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
      await ctx.plugin(MessageFeedbackService, { maxNoteBytes: 1024 })
      await ctx.plugin(OpenTelemetrySessionBackend, { mode, exporter: { url }, processor: { scheduledDelayMillis: 1 } })
      const parent = Session.create(SessionId('cold-parent'))
      parent.append('request/header', { header: { config: { provider: 'mock', model: 'm' } }, reason: 'initial' })
      const message = createAssistantMessage({ content: [{ type: 'text', text: 'inherited answer' }], source: { provider: 'mock', model: 'm' } })
      parent.append('assistant/message', { message, stream: [], turn: 1, step: 1 }, { surfaceOp: 'append' })
      const child = Session.create(SessionId('cold-child'), parent.snapshotEvents(), {
        ...parent.header, id: SessionId('cold-child'), parentSession: parent.id, isSeeded: true,
      }, parent.seq)
      recordFeedback(child, 'child-owned stored feedback')
      const handle = await ctx.sessionPersistence.create(child.header, { inheritedEventCount: child.inheritedEventCount })
      try {
        await handle.append(child.snapshotEvents())
      } finally {
        await handle.close()
      }
      expect(child.seq).toBeGreaterThan(child.inheritedEventCount)
      const put = await ctx.messageFeedback.put({ sessionId: child.id, messageId: message.id, rating: 'positive', ifVersion: null })
      if (!put.ok) throw new Error('cold child feedback failed')
      expect(ctx.sessions.list()).toEqual([])
      const read = await ctx.sessionPersistence.open(child.id, 'read')
      try {
        const { events } = await read.read()
        expect(events.at(-1)?.type).toBe('feedback/message-put')
        expect(events).toHaveLength(child.seq + 1)
      } finally {
        await read.close()
      }
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
    expect(eventTypes(captures)).toEqual([
      'request/header', 'assistant/message', 'session/end-seed', 'feedback/record', 'feedback/message-put',
    ])
    expect(allRecords(captures).some(record => record.scope.endsWith('/ops'))).toBe(false)
  })

  it.each([
    ['mock', SessionTelemetryMode.FEEDBACK_ONLY],
    ['deepseek-official', SessionTelemetryMode.FEEDBACK_ONLY],
    [undefined, SessionTelemetryMode.FEEDBACK_ONLY],
    ['mock', SessionTelemetryMode.DISABLED],
  ] as const)('captures cold put, note edit and withdrawal for %s in %s without opening a live Session', async (provider, mode) => {
    const { url, captures } = await mockCollector()
    const root = mkdtempSync(join(tmpdir(), 'dsh-otel-cold-'))
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
      await ctx.plugin(MessageFeedbackService, { maxNoteBytes: 1024 })
      await ctx.plugin(OpenTelemetrySessionBackend, { mode, exporter: { url }, processor: { scheduledDelayMillis: 1 } })
      const session = Session.create(SessionId('cold-feedback'))
      if (provider !== undefined) session.append('request/header', { header: { config: { provider, model: 'm' } }, reason: 'initial' })
      const message = createAssistantMessage({ content: [{ type: 'text', text: 'answer' }], source: { provider: provider ?? 'mock', model: 'm' } })
      session.append('assistant/message', { message, stream: [], turn: 1, step: 1 }, { surfaceOp: 'append' })
      const handle = await ctx.sessionPersistence.create(session.header)
      try {
        await handle.append(session.snapshotEvents())
      } finally {
        await handle.close()
      }
      const observer = vi.fn()
      ctx.on('feedback/committed', observer)
      ctx.on('feedback/committed', () => { throw new Error('observer failure') })
      const request = { sessionId: session.id, messageId: message.id, rating: 'positive' as const, ifVersion: null }
      expect(captures).toEqual([])
      const put = await ctx.messageFeedback.put(request)
      expect(put.ok).toBe(true)
      if (!put.ok) throw new Error('put failed')
      if (mode !== SessionTelemetryMode.DISABLED) await expect.poll(() => eventTypes(captures).filter(type => type === 'feedback/message-put').length).toBe(1)
      await ctx.messageFeedback.put({ ...request, ifVersion: put.value.version })
      const edit = await ctx.messageFeedback.put({ ...request, ifVersion: put.value.version, note: 'explanation' })
      if (!edit.ok) throw new Error('edit failed')
      if (mode !== SessionTelemetryMode.DISABLED) await expect.poll(() => eventTypes(captures).filter(type => type === 'feedback/message-put').length).toBe(3)
      await ctx.messageFeedback.delete({ sessionId: session.id, messageId: message.id, ifVersion: edit.value.version })
      if (mode !== SessionTelemetryMode.DISABLED) await expect.poll(() => eventTypes(captures)).toContain('feedback/message-delete')
      expect(observer).toHaveBeenCalledTimes(3)
      expect(ctx.sessions.list()).toEqual([])
      expect(await ctx.messageFeedback.list({ sessionId: session.id })).toEqual({ ok: true, value: { items: [] } })
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
    expect(warn).not.toHaveBeenCalledWith(
      'OpenTelemetry session upload is DISABLED; this feedback is not uploaded through OpenTelemetry',
    )
    if (mode === SessionTelemetryMode.DISABLED) expect(captures).toEqual([])
    else {
      expect(eventTypes(captures)).toContain('feedback/message-put')
      expect(eventTypes(captures)).toContain('feedback/message-delete')
      expect(JSON.stringify(captures)).toContain('explanation')
      expect(eventTypes(captures)).not.toContain('session/end-seed')
      expect(allRecords(captures).some(record => record.scope.endsWith('/ops'))).toBe(false)
    }
  })
})

describe('OpenTelemetrySessionBackend config fails loud', () => {
  it('exposes modes through the nominal enum', () => {
    expectTypeOf<Config['mode']>().toEqualTypeOf<SessionTelemetryMode | undefined>()
    expectTypeOf<'FULL'>().not.toExtend<SessionTelemetryMode>()
    expectTypeOf<SessionTelemetryMode.FEEDBACK_ONLY>().toExtend<SessionTelemetryMode>()
    expect(Object.values(SessionTelemetryMode)).toEqual(['FEEDBACK_ONLY', 'DISABLED'])
    expect(() => Config({ mode: 'FULL' } as unknown as Config)).toThrow()
    expect(DEFAULT_TELEMETRY_MODE).toBe(SessionTelemetryMode.FEEDBACK_ONLY)
    expect(Config({}).mode).toBe(DEFAULT_TELEMETRY_MODE)
  })

  it.each([
    [{}, /exporter\.url is required/],
    [{ mode: SessionTelemetryMode.FEEDBACK_ONLY }, /exporter\.url is required/],
    [{ mode: SessionTelemetryMode.FEEDBACK_ONLY, exporter: { url: '' } }, /exporter\.url is required/],
    [{ mode: SessionTelemetryMode.FEEDBACK_ONLY, exporter: { url: 'not a url' } }, /not a valid URL/],
    [{ mode: SessionTelemetryMode.FEEDBACK_ONLY, exporter: { url: 'ftp://collector' } }, /must be http\(s\)/],
    [{ mode: 'INVALID' }, /INVALID/],
    [{ mode: 'FULL' }, /FULL/],
    // The SDK accepts a non-positive batch size but its shutdown drain then
    // splices empty batches forever — dispose would hang, so reject at load.
    [{ mode: SessionTelemetryMode.FEEDBACK_ONLY, exporter: { url: 'http://c/v1/logs' }, processor: { maxExportBatchSize: 0 } }, /maxExportBatchSize/],
    [{ mode: SessionTelemetryMode.FEEDBACK_ONLY, exporter: { url: 'http://c/v1/logs' }, processor: { maxExportBatchSize: 0.5 } }, /maxExportBatchSize/],
    [{ mode: SessionTelemetryMode.FEEDBACK_ONLY, exporter: { url: 'http://c/v1/logs' }, shutdownTimeoutMillis: 0 }, /shutdownTimeoutMillis/],
    [{ mode: SessionTelemetryMode.FEEDBACK_ONLY, exporter: { url: 'http://c/v1/logs' }, shutdownTimeoutMillis: Number.POSITIVE_INFINITY }, /shutdownTimeoutMillis/],
  ])('rejects %j at plugin load', async (config, message) => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await expect(ctx.plugin(OpenTelemetrySessionBackend, config as Config)).rejects.toThrow(message)
  })

  it.each(['INVALID', 'FULL'])('rejects direct mode %s before reading transport config', async (mode) => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    let exporterRead = false
    const config = {
      mode,
      get exporter() {
        exporterRead = true
        throw new Error('transport config was read')
      },
    } as unknown as Config

    expect(() => new OpenTelemetrySessionBackend(ctx, config)).toThrow(`unsupported mode "${mode}"`)
    expect(exporterRead).toBe(false)
  })

  it('does not read any transport setting in disabled mode', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const transportRead = vi.fn(() => {
      throw new Error('transport config was read')
    })
    const config = {
      mode: SessionTelemetryMode.DISABLED,
      get exporter() {
        return transportRead()
      },
      get processor() {
        return transportRead()
      },
      get shutdownTimeoutMillis() {
        return transportRead()
      },
    } as unknown as Config

    new OpenTelemetrySessionBackend(ctx, config)
    expect(transportRead).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})

describe('dsh-session-telemetry-otel real-load-path guard', () => {
  it('keeps the Service class with inject/Config through unwrapExports', async () => {
    const module = await import('../src/index.ts')
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(module) as typeof OpenTelemetrySessionBackend
    expect(unwrapped).toBe(OpenTelemetrySessionBackend)
    expect(unwrapped.inject).toEqual(['sessions'])
    expect(typeof unwrapped.Config).toBe('function')
  })

  it('boots through the unwrapped class and registers ctx.sessionTelemetry', async () => {
    const { url } = await mockCollector()
    const module = await import('../src/index.ts')
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(module) as Parameters<Context['plugin']>[0]
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(unwrapped, { mode: SessionTelemetryMode.FEEDBACK_ONLY, exporter: { url } })
    expect(ctx.sessionTelemetry).toBeInstanceOf(OpenTelemetrySessionBackend)
    await fiber.dispose()
  })
})
