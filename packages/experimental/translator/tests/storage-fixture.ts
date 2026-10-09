/** Loader-owned anonymous provider, live Sessions, and restartable real JSONL storage. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq, type Session, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Translator from '../src/index.ts'

/** One external anonymous request, with only the relevant protocol facts. */
export interface StorageWireCall { provider: 'bing' | 'google'; path: string; text: string; source: string; target: string }
/** Fixture-owned response control; no Host or model requests are intercepted. */
export interface StorageFixtureOptions {
  reply?: (call: StorageWireCall, response: ServerResponse) => void | Promise<void>
  withPersistence?: boolean
  withSessions?: boolean
}

/** JSON response matching the selected external translation protocol. */
export function storageReply(call: StorageWireCall, response: ServerResponse, text = 'Stored translation'): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(call.provider === 'bing'
    ? [{ translations: [{ text, to: call.target }] }]
    : [[[text, call.text, null, null]], null, 'en']))
}

function mainEvents(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: SessionSeq(1), time: 2, surfaceOp: 'append',
      data: createUserMessage({ content: [{ type: 'text', text: 'Main conversation' }], source: { kind: 'user' } }) },
    { type: 'step/start', seq: SessionSeq(2), time: 3, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: SessionSeq(3), time: 4, surfaceOp: 'append', data: { turn: 1, step: 1, stream: [],
      message: createAssistantMessage({ content: [{ type: 'reasoning', text: 'Original paragraph' }],
        source: { provider: 'main-provider', model: 'main-model' } }) } },
    { type: 'step/end', seq: SessionSeq(4), time: 5, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: SessionSeq(5), time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/**
 * Create private, atomically allocated resources and register teardown before use.
 * @param cleanups - owning test's reverse-order quiescent cleanup list.
 * @param options - external reply control and optional storage omission.
 * @returns the real Host composition, restart operation, and Session/storage observations.
 */
export async function storageFixture(cleanups: Array<() => Promise<void>>, options: StorageFixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-translator-storage-'))
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
  const requests: StorageWireCall[] = [], errors: unknown[] = [], handlers = new Set<Promise<void>>()
  const respond = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      if (!(chunk instanceof Buffer)) throw new Error('Expected HTTP bytes')
      chunks.push(chunk)
    }
    const url = new URL(request.url ?? '/', 'http://translation.test')
    const body = Buffer.concat(chunks).toString('utf8')
    const provider = url.pathname.startsWith('/google') ? 'google' : 'bing'
    const form = new URLSearchParams(body)
    const value: unknown = provider === 'bing' ? JSON.parse(body) : undefined
    if (provider === 'bing' && (!Array.isArray(value) || typeof value[0] !== 'string')) throw new Error('Expected Bing text array')
    const text = provider === 'google' ? form.get('q') ?? '' : String(Array.isArray(value) ? value[0] : '')
    const call: StorageWireCall = { provider, path: url.pathname, text,
      source: provider === 'google' ? form.get('sl') ?? '' : url.searchParams.get('from') ?? 'auto',
      target: provider === 'google' ? form.get('tl') ?? '' : url.searchParams.get('to') ?? '' }
    requests.push(call)
    if (options.reply === undefined) storageReply(call, response)
    else await options.reply(call, response)
  }
  const server = createServer((request, response) => {
    const work = respond(request, response).catch((error: unknown) => { errors.push(error); response.destroy() })
    handlers.add(work)
    void work.then(() => { handlers.delete(work) })
  })
  cleanups.push(async () => {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    }))
    server.closeAllConnections()
    await closed
    await Promise.all(handlers)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected allocated loopback listener')
  const origin = `http://127.0.0.1:${address.port}`, path = join(root, 'cordis.yml'), storedRoot = join(root, 'sessions')
  const config = { bingEndpoint: `${origin}/bing`, googleEndpoint: `${origin}/google`, timeoutMs: 60_000 }
  await writeFile(path, JSON.stringify([
    ...options.withSessions === false ? [] : [{ id: 'sessions', name: '@deepseek-ai/dsh-session' }],
    ...options.withPersistence === false ? [] : [
      { id: 'storage', name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: storedRoot, compression: 'none' } },
    ],
    { id: 'translator', name: '@deepseek-ai/dsh-experimental-translator', config },
  ]))
  const start = () => boot('translator-storage', path, [], (host) => {
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-session', SessionStore], ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlPersistence],
      ['@deepseek-ai/dsh-experimental-translator', Translator],
    ])
    const loader: ModuleLoaderV2 = {
      version: 'v2', loadCache: new Map(),
      async import(specifier) {
        if (!modules.has(specifier)) throw new Error(`Unexpected fixture import ${specifier}`)
        return modules.get(specifier)
      },
      register(): never { throw new Error('Unexpected module hook registration') },
      getOrCreateModuleJob(): never { throw new Error('Unexpected module job creation') },
      resolveSync(): never { throw new Error('Unexpected synchronous module resolution') },
      load(): never { throw new Error('Unexpected module load') },
    }
    host.loader.internal = loader
  })
  let ctx = await start()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  const readEvents = async (id: SessionId): Promise<readonly SessionEvent[]> => {
    await using handle = await ctx.sessionPersistence.open(id, 'read')
    return (await handle.read()).events
  }
  const createSession = async (id: SessionId = SessionId('stored-translation'), live = true) => {
    const events = mainEvents()
    const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id, createdAt: 1, cwd: root, isSeeded: false, delegationDepth: 0 }
    let session: Session | undefined, scope: Fiber | undefined, writer: SessionHandle | undefined
    if (live) {
      scope = ctx.plugin({ inject: ['sessions'], apply(owner: Context) {
        session = owner.sessions.create(id, { meta: { createdAt: 1, cwd: root, isSeeded: false, delegationDepth: 0 } })
      } })
      await scope.await()
      if (session === undefined) throw new Error('Live Session was not published')
      writer = await ctx.sessionPersistence.create(session.header)
      for (const event of events) {
        switch (event.type) {
          case 'user/message': session.append(event.type, event.data, { surfaceOp: 'append' }); break
          case 'assistant/message': session.append(event.type, event.data, { surfaceOp: 'append' }); break
          case 'turn/start': session.append(event.type, event.data); break
          case 'step/start': session.append(event.type, event.data); break
          case 'step/end': session.append(event.type, event.data); break
          case 'turn/end': session.append(event.type, event.data); break
          default: throw new Error('Unexpected main fixture event')
        }
      }
      await ctx.sessions.flush(session)
    } else {
      await using handle = await ctx.sessionPersistence.create(header)
      await handle.append(events)
      await handle.flush()
    }
    const artifacts = (await readdir(storedRoot, { recursive: true })).filter(value => value.endsWith(join(id, `session.v${SESSION_FORMAT_VERSION}.jsonl`)))
    if (artifacts.length !== 1) throw new Error('Expected one current Session artifact')
    const file = join(storedRoot, artifacts[0]!)
    return { id, session, scope, writer, events: await readEvents(id), file, bytes: await readFile(file) }
  }
  return { get ctx() { return ctx }, root, config, requests, errors, readEvents, createSession,
    async restart() { await ctx.fiber.dispose(); ctx = await start() } }
}
