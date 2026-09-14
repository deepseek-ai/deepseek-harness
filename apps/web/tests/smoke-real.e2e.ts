// Real-host smoke: spawn `dsh web` with a real key, walk the full flow
// list in a real chromium, screenshot every screen into .artifacts/ for the
// figma comparison pass. Self-skips without DEEPSEEK_API_KEY (repo e2e
// convention); vitest.web.config.ts loads the repo-root .env before this file
// runs (the CLI only auto-loads .env from its cwd — a temp dir here, so
// sessions never land in the repo's .sessions).
//
// Selector convention: CSS Modules hash as [hash]_[local], so class-substring
// selectors are unreliable — anchor on data-* attributes (data-variant /
// data-sample) or visible text. The one [class*=] use below
// (frame/handle) rides local names that survive hashing as suffixes; prefer
// data-* for anything new.
//
// Flow order matters: chat rounds first (the bash round reuses the first
// send's session), geometry and theme after, reload recovery last. Tests run
// sequentially in-file.
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire, SourceMap } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import WebSocket from 'ws'
import { REPO_ROOT, connectFreshWorkspace, newEnglishPage, probeFreePort, requireDist, saveFailureShot } from './support.ts'

const WEB_SURFACE_PROMPT = fileURLToPath(new URL('./expected/web-runtime-context/web-surface-prompt.expected.md', import.meta.url))
const authenticatedCookies = new Map<string, Promise<{ origin: string; cookie: string }>>()

/** Frame a complete text turn or an open block before a transport failure. */
function messagesResponse(text: string, complete = true): string {
  const events: object[] = [
    { type: 'message_start', message: { id: 'web-smoke-response', model: 'mock-model', usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
  ]
  if (complete) events.push(
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  )
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
}

/** Exchange a printed process token once for Node-side HTTP/WebSocket probes. */
function authenticatedWeb(launchUrl: string): Promise<{ origin: string; cookie: string }> {
  const existing = authenticatedCookies.get(launchUrl)
  if (existing !== undefined) return existing
  const exchange = (async () => {
    const response = await fetch(launchUrl, { redirect: 'manual' })
    const setCookie = response.headers.get('set-cookie')
    if (response.status !== 303 || setCookie === null) {
      throw new Error(`dsh web authentication returned HTTP ${String(response.status)}`)
    }
    return {
      origin: new URL(launchUrl).origin,
      cookie: setCookie.split(';', 1)[0]!,
    }
  })()
  authenticatedCookies.set(launchUrl, exchange)
  return exchange
}

const comboMapUrl = (url: string): string => url.replace(/\/client\.js(?=,|&rev=)/g, '/client.js.map')

function waitForReadyLine(child: ChildProcess): Promise<string> {
  return new Promise((resolveReady, reject) => {
    let out = ''
    const timer = setTimeout(() => { reject(new Error(`dsh web not ready in 90s; output:\n${out}`)) }, 90_000)
    const onData = (chunk: Buffer): void => {
      out += chunk.toString()
      const match = /dsh web: (http:\/\/[^\s]+)/.exec(out)
      if (match?.[1] !== undefined) {
        clearTimeout(timer)
        resolveReady(match[1])
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`dsh web exited early (code ${code}); output:\n${out}`))
    })
  })
}

async function remoteRpc<T>(baseUrl: string, endpoint: string, args: object): Promise<T> {
  const authenticated = await authenticatedWeb(baseUrl)
  const response = await fetch(`${authenticated.origin}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: authenticated.cookie },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `smoke-${endpoint}`,
      method: endpoint,
      payload: { args },
    }),
  })
  if (!response.ok) throw new Error(`${endpoint} failed over HTTP ${response.status}: ${await response.text()}`)
  const body = await response.json() as {
    result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
  }
  if (!body.result.ok) throw new Error(`${endpoint} failed: ${body.result.error.code}: ${body.result.error.message}`)
  return body.result.value
}

/** Read the explicit page cut from a freshly opened Session follow stream. */
async function sessionCursor(baseUrl: string, sessionId: string): Promise<number> {
  const authenticated = await authenticatedWeb(baseUrl)
  const socket = new WebSocket(`${authenticated.origin.replace(/^http/u, 'ws')}/api/remote.mux`, {
    headers: { cookie: authenticated.cookie },
  })
  const streamId = `smoke-history-${randomUUID()}`
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        socket.removeEventListener('open', opened)
        socket.removeEventListener('error', failed)
        socket.removeEventListener('close', closed)
      }
      const opened = (): void => {
        cleanup()
        resolve()
      }
      const failed = (): void => {
        cleanup()
        reject(new Error('session/follow carrier failed before opening'))
      }
      const closed = (): void => {
        cleanup()
        reject(new Error('session/follow carrier closed before opening'))
      }
      socket.addEventListener('open', opened)
      socket.addEventListener('error', failed)
      socket.addEventListener('close', closed)
    })
    return await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { finish(new Error('session/follow did not publish an opening cursor')) }, 10_000)
      const cleanup = (): void => {
        clearTimeout(timer)
        socket.removeEventListener('message', message)
        socket.removeEventListener('error', failed)
        socket.removeEventListener('close', closed)
      }
      const finish = (error: Error | undefined, cursor?: number): void => {
        cleanup()
        if (error !== undefined) reject(error)
        else resolve(cursor ?? -1)
      }
      const message = (event: WebSocket.MessageEvent): void => {
        try {
          const text = typeof event.data === 'string'
            ? event.data
            : Buffer.isBuffer(event.data) ? event.data.toString('utf8') : undefined
          if (text === undefined) throw new Error('session/follow published a non-text frame')
          const frame: unknown = JSON.parse(text)
          if (!isRecord(frame) || frame.streamId !== streamId) return
          if (frame.type === 'error') {
            finish(new Error(`session/follow failed: ${JSON.stringify(frame.error)}`))
            return
          }
          if (frame.type === 'end') {
            finish(new Error('session/follow ended before its opening cursor'))
            return
          }
          const value = frame.value
          if (frame.type === 'item' && isRecord(value)
            && value.type === 'snapshot' && Number.isSafeInteger(value.cursor)) {
            finish(undefined, value.cursor as number)
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      }
      const failed = (): void => { finish(new Error('session/follow carrier failed before its opening cursor')) }
      const closed = (): void => { finish(new Error('session/follow carrier closed before its opening cursor')) }
      socket.addEventListener('message', message)
      socket.addEventListener('error', failed)
      socket.addEventListener('close', closed)
      socket.send(JSON.stringify({
        type: 'open',
        streamId,
        endpoint: 'session/follow',
        payload: { args: { request: { address: { kind: 'session', sessionId } } } },
      }))
    })
  } finally {
    socket.close()
  }
}

interface HistoryPage {
  records: (
    | { type: 'event'; event: HistoryEvent }
    | { type: 'chunks'; event: HistoryEvent }
  )[]
  hasMore: boolean
}

interface HistoryEvent {
  type: string
  data: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function providerTitle(page: HistoryPage): string | undefined {
  const events = page.records.flatMap(record => record.type === 'event' ? [record.event] : [])
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index] as HistoryEvent
    if (event.type !== 'session/title' || !isRecord(event.data)) continue
    const source = event.data.source
    if (typeof event.data.title === 'string' && isRecord(source) && source.kind === 'provider') {
      return event.data.title
    }
  }
  return undefined
}

function hasAssistantMarker(page: HistoryPage, marker: string): boolean {
  return page.records.some((record) => {
    if (record.type !== 'event') return false
    const { event } = record
    if (event.type !== 'assistant/message' || !isRecord(event.data) || !isRecord(event.data.message)) return false
    const content = event.data.message.content
    if (!Array.isArray(content)) return false
    return content.some(block =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string' && block.text.includes(marker))
  })
}

async function history(baseUrl: string, sessionId: string): Promise<HistoryPage> {
  const throughSeq = await sessionCursor(baseUrl, sessionId)
  return remoteRpc<HistoryPage>(baseUrl, 'session/page', {
    request: { address: { kind: 'session', sessionId }, throughSeq, maxMessages: 10 },
  })
}

async function waitForProviderTitle(baseUrl: string, sessionId: string): Promise<string> {
  let observed: string | undefined
  await expect.poll(async () => {
    observed = providerTitle(await history(baseUrl, sessionId))
    return observed
  }, { timeout: 90_000 }).toEqual(expect.any(String))
  if (observed === undefined) throw new Error('provider-backed session title was not observed')
  return observed
}

async function waitForAssistantMarker(baseUrl: string, sessionId: string, marker: string): Promise<void> {
  await expect.poll(async () => hasAssistantMarker(await history(baseUrl, sessionId), marker), {
    timeout: 120_000,
  }).toBe(true)
}

/** Find one real source location through a served indexed map. */
function firstMappedSource(script: string, payload: ConstructorParameters<typeof SourceMap>[0]): string | undefined {
  const consumer = new SourceMap(payload)
  const lines = script.split('\n')
  for (let line = 0; line < lines.length; line++) {
    const lastColumn = Math.min(lines[line]!.length, 512)
    for (let column = 0; column <= lastColumn; column++) {
      const entry = consumer.findEntry(line, column)
      if (!('originalSource' in entry) || typeof entry.originalSource !== 'string') continue
      if (entry.originalSource.startsWith('/packages/') && entry.originalSource.includes('/src/')) {
        return entry.originalSource
      }
    }
  }
  return undefined
}

/** Real-host smoke screenshot: evidence for the figma comparison, not a failure artifact. */
async function screen(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(REPO_ROOT, '.artifacts', `w5-${name}.png`) })
}

/** First column track (px string) of the frame grid. */
async function firstTrack(page: Page): Promise<string> {
  return (await page.locator('[class*="frame"]').evaluate(
    el => getComputedStyle(el).gridTemplateColumns)).split(' ')[0]!
}

/** Last column track (details) as a number of pixels. */
async function detailsTrack(page: Page): Promise<number> {
  const cols = await page.locator('[class*="frame"]').evaluate(
    el => getComputedStyle(el).gridTemplateColumns)
  return Number(cols.split(' ').pop()!.replace('px', ''))
}

// Readiness gate: `dsh web` serves every production manifest plugin; until every UI
// plugin's client bundle exists and exports apply, the loader fail-louds and
// the frame never appears.
const UI_PLUGIN_DIRS = [
  'connection', 'ui-theme', 'locale', 'ui-layout', 'ui-renderer', 'ui-session', 'ui-sidebar',
  'ui-settings', 'ui-settings-general', 'ui-settings-models', 'ui-conversation', 'ui-approval', 'ui-chat',
  'ui-model-selection', 'ui-user-questions', 'ui-trajectory', '../session-query/session-log-export',
]
const ROUND_DONE_MARKER = 'WEB_ROUND_DONE'
const notReady = UI_PLUGIN_DIRS.filter((dir) => {
  const bundle = join(REPO_ROOT, 'packages/client', dir, 'lib/client.js')
  return !existsSync(bundle) || !readFileSync(bundle, 'utf8').includes('exports.apply')
})
if (notReady.length > 0) console.warn(`[smoke-real] skipped — client bundles not ready: ${notReady.join(', ')}`)

describe('dsh web keyless CLI smoke', () => {
  it('serves a usable app from two immutable plugin batches', async () => {
    requireDist()
    const sessionsDir = mkdtempSync(join(tmpdir(), 'dsh-web-keyless-'))
    const tsxLoader = pathToFileURL(createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx')).href
    const child = spawn(
      process.execPath,
      ['--import', tsxLoader, join(REPO_ROOT, 'apps/cli/src/bin.ts'), 'web', '--no-open', '--port', '0'],
      {
        cwd: sessionsDir,
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: 'keyless-web-no-call',
          DSH_HOME: join(sessionsDir, '.dsh'),
          DSH_AGENTS_HOME: join(sessionsDir, '.agents'),
          TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let browser: Browser | undefined
    try {
      const readyUrl = await waitForReadyLine(child)
      expect(readyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+$/u)
      expect((await fetch(readyUrl, { redirect: 'manual' })).status).toBe(303)
      browser = await chromium.launch({ headless: true })
      const page = await newEnglishPage(browser)
      const pluginScripts: string[] = []
      const cacheHeaders = new Map<string, string | undefined>()
      // Chromium reports `preload as=script` as Script and reuses that same
      // request when the matching script node executes; this count pins both.
      page.on('request', (request) => {
        const url = new URL(request.url())
        const resource = `${url.pathname}${url.search}`
        if (request.resourceType() === 'script' && resource.startsWith('/plugins/??')) {
          pluginScripts.push(resource)
        }
      })
      page.on('response', (response) => {
        const url = new URL(response.url())
        const resource = `${url.pathname}${url.search}`
        if (resource.startsWith('/plugins/??')) {
          cacheHeaders.set(resource, response.headers()['cache-control'])
        }
      })
      await page.goto(readyUrl)
      await page.getByRole('button', { name: 'New session', exact: true }).first().waitFor({ timeout: 30_000 })
      const batchPaths = [...new Set(pluginScripts)].sort()
      expect(batchPaths).toHaveLength(2)
      expect(batchPaths).toContainEqual(expect.stringMatching(
        /^\/plugins\/\?\?.+\/client\.js,.+\/client\.js&rev=[a-f\d]{12}$/,
      ))
      expect(batchPaths).toContainEqual(expect.stringMatching(
        /^\/plugins\/\?\?@deepseek-ai\/dsh-client-modules\/client\.js&rev=[a-f\d]{12}$/,
      ))
      const readyOrigin = new URL(readyUrl).origin
      expect([...cacheHeaders.values()]).toEqual([
        'public, max-age=31536000, immutable',
        'public, max-age=31536000, immutable',
      ])
      for (const path of batchPaths) {
        const [scriptResponse, mapResponse] = await Promise.all([
          fetch(`${readyOrigin}${path}`),
          fetch(`${readyOrigin}${comboMapUrl(path)}`),
        ])
        expect(scriptResponse.status).toBe(200)
        expect(mapResponse.status).toBe(200)
        const script = await scriptResponse.text()
        const payload = await mapResponse.json() as ConstructorParameters<typeof SourceMap>[0]
        const sections = (payload as unknown as {
          sections: { map: { sources?: unknown[]; sourcesContent?: unknown[] } }[]
        }).sections
        expect(sections.every(section => (
          Array.isArray(section.map.sources)
          && Array.isArray(section.map.sourcesContent)
          && section.map.sourcesContent.length === section.map.sources.length
          && section.map.sourcesContent.every(source => typeof source === 'string')
        ))).toBe(true)
        expect(firstMappedSource(script, payload)).toMatch(/^\/packages\/.+\/src\//)
      }
    } finally {
      await browser?.close()
      const closed = child.exitCode === null
        ? new Promise<void>((resolveClose) => { child.once('close', () => { resolveClose() }) })
        : Promise.resolve()
      if (child.exitCode === null) child.kill('SIGTERM')
      await closed
      rmSync(sessionsDir, { recursive: true, force: true })
    }
  })

  it('routes web runtime context and workspace instructions through the real CLI request', async () => {
    requireDist()
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-web-workspace-'))
    mkdirSync(join(workspace, '.git'))
    writeFileSync(join(workspace, 'AGENTS.md'), 'web-workspace-context-probe\n')

    interface NativeProviderRequest {
      system?: string
      messages?: { role?: string; content?: { type?: string; text?: string }[] }[]
      tools?: { name?: string }[]
    }
    let resolveProviderRequests!: (requests: NativeProviderRequest[]) => void
    const requests: NativeProviderRequest[] = []
    const providerRequests = new Promise<NativeProviderRequest[]>((resolve) => {
      resolveProviderRequests = resolve
    })
    const provider = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        const parsed = JSON.parse(body) as NativeProviderRequest
        if ((parsed.tools?.length ?? 0) > 0) requests.push(parsed)
        if (requests.length === 1) resolveProviderRequests(requests)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(messagesResponse('done'))
      })
    })
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const address = provider.address()
    if (address === null || typeof address === 'string') throw new Error('mock provider did not bind a TCP port')
    const tsxLoader = pathToFileURL(createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx')).href
    const child = spawn(
      process.execPath,
      ['--import', tsxLoader, join(REPO_ROOT, 'apps/cli/src/bin.ts'), 'web', '--no-open', '--port', '0'],
      {
        cwd: workspace,
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: 'keyless-web-workspace',
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
          DSH_HOME: join(workspace, '.dsh'),
          DSH_AGENTS_HOME: join(workspace, '.agents'),
          TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    try {
      const baseUrl = await waitForReadyLine(child)
      const created = await remoteRpc<{ sessionId: string }>(baseUrl, 'session/create', { request: {} })
      await remoteRpc<{ accepted: true }>(baseUrl, 'session/prompt', { request: {
        requestId: randomUUID(),
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'go' }],
      } })
      const capturedRequests = await Promise.race([
        providerRequests,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => { reject(new Error('provider request not received in 10s')) }, 10_000).unref()
        }),
      ])
      const captured = capturedRequests[0]
      if (captured === undefined) {
        throw new Error('provider did not receive the workspace projection request')
      }
      const workspaceMessage = captured.messages?.filter(message => message.role === 'user')
        .flatMap(message => message.content ?? [])
        .find(block => block.type === 'text' && block.text?.includes('web-workspace-context-probe'))
      const expectedWebSection = readFileSync(WEB_SURFACE_PROMPT, 'utf8').trimEnd()
        .replace('{{webUrl}}', new URL(baseUrl).origin)
      expect(captured.system).toContain(expectedWebSection)
      expect(workspaceMessage).toMatchInlineSnapshot(`
        {
          "text": "<system-reminder>
        The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.

        Instructions from: AGENTS.md

        web-workspace-context-probe

        </system-reminder>",
          "type": "text",
        }
      `)
      expect(captured.tools?.map(tool => tool.name)
        .filter(name => name === 'web_search' || name === 'web_fetch'))
        .toMatchInlineSnapshot(`
          [
            "web_fetch",
            "web_search",
          ]
        `)
    } finally {
      const closed = child.exitCode === null
        ? new Promise<void>((resolveClose) => { child.once('close', () => { resolveClose() }) })
        : Promise.resolve()
      if (child.exitCode === null) child.kill('SIGTERM')
      await closed
      await new Promise<void>(resolveClose => provider.close(() => { resolveClose() }))
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('retries a partial transport failure through the shipped Web composition', async () => {
    requireDist()
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-web-retry-'))
    const promptMarker = 'WEB_RETRY_REQUEST'
    const recoveredMarker = 'WEB_RETRY_RECOVERED'
    let mainAttempts = 0
    const provider = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        const parsed = JSON.parse(body) as { max_tokens?: number; messages?: unknown[] }
        const titleRequest = parsed.max_tokens === 64
        const mainRequest = !titleRequest && body.includes(promptMarker)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        if (!mainRequest) {
          response.end(messagesResponse('Web retry title'))
          return
        }
        mainAttempts++
        if (mainAttempts === 1) {
          response.write(messagesResponse('WEB_RETRY_DISCARDED', false))
          setTimeout(() => { response.destroy() }, 20)
          return
        }
        response.end(messagesResponse(recoveredMarker))
      })
    })
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const address = provider.address()
    if (address === null || typeof address === 'string') throw new Error('mock provider did not bind a TCP port')
    const tsxLoader = pathToFileURL(createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx')).href
    const child = spawn(
      process.execPath,
      ['--import', tsxLoader, join(REPO_ROOT, 'apps/cli/src/bin.ts'), 'web', '--no-open', '--port', '0'],
      {
        cwd: workspace,
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: 'keyless-web-retry',
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
          DSH_HOME: join(workspace, '.dsh'),
          TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    try {
      const baseUrl = await waitForReadyLine(child)
      const created = await remoteRpc<{ sessionId: string }>(baseUrl, 'session/create', { request: {} })
      await remoteRpc<{ accepted: true }>(baseUrl, 'session/prompt', { request: {
        requestId: randomUUID(),
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: promptMarker }],
      } })
      let page: HistoryPage | undefined
      await expect.poll(async () => {
        page = await history(baseUrl, created.sessionId)
        return hasAssistantMarker(page, recoveredMarker)
      }, { timeout: 20_000 }).toBe(true)
      if (page === undefined) throw new Error('retry history was not observed')
      const retry = page.records.find(record => (
        record.type === 'event' && record.event.type === 'llm/retry'
      ))
      expect(mainAttempts).toBe(2)
      expect(retry?.type === 'event' ? retry.event.data : undefined).toMatchObject({
        turn: 1,
        step: 1,
        retry: 1,
        maxRetries: 5,
        failure: { code: 'TRANSPORT' },
      })
      expect(JSON.stringify(page.records)).toContain('WEB_RETRY_DISCARDED')
    } finally {
      const closed = child.exitCode === null
        ? new Promise<void>((resolveClose) => { child.once('close', () => { resolveClose() }) })
        : Promise.resolve()
      if (child.exitCode === null) child.kill('SIGTERM')
      await closed
      await new Promise<void>(resolveClose => provider.close(() => { resolveClose() }))
      rmSync(workspace, { recursive: true, force: true })
    }
  }, 120_000)

  it('DSH_TOOLS_MODE=ptc collapses the provider wire tools to run_code with the SDK prompt section', async () => {
    requireDist()
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-web-ptc-'))

    interface PtcModeProviderRequest {
      system?: string
      messages?: { role?: string; content?: { type?: string; text?: string }[] }[]
      tools?: { name?: string }[]
    }
    let resolveProviderRequest!: (request: PtcModeProviderRequest) => void
    const providerRequest = new Promise<PtcModeProviderRequest>((resolve) => {
      resolveProviderRequest = resolve
    })
    const provider = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        resolveProviderRequest(JSON.parse(body) as PtcModeProviderRequest)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(messagesResponse('done'))
      })
    })
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const address = provider.address()
    if (address === null || typeof address === 'string') throw new Error('mock provider did not bind a TCP port')
    const tsxLoader = pathToFileURL(createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx')).href
    const child = spawn(
      process.execPath,
      ['--import', tsxLoader, join(REPO_ROOT, 'apps/cli/src/bin.ts'), 'web', '--no-open', '--port', '0'],
      {
        cwd: workspace,
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: 'keyless-web-ptc',
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
          DSH_TOOLS_MODE: 'ptc',
          DSH_HOME: join(workspace, '.dsh'),
          DSH_AGENTS_HOME: join(workspace, '.agents'),
          TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    try {
      const baseUrl = await waitForReadyLine(child)
      const created = await remoteRpc<{ sessionId: string }>(baseUrl, 'session/create', { request: {} })
      await remoteRpc<{ accepted: true }>(baseUrl, 'session/prompt', { request: {
        requestId: randomUUID(),
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'go' }],
      } })
      const captured = await Promise.race([
        providerRequest,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => { reject(new Error('provider request not received in 10s')) }, 10_000).unref()
        }),
      ])
      expect(captured.tools?.map(tool => tool.name)).toEqual(['run_code'])
      expect(captured.system).toContain('## Writing code for run_code')
      expect(captured.system).toContain('declare const tools')
    } finally {
      const closed = child.exitCode === null
        ? new Promise<void>((resolveClose) => { child.once('close', () => { resolveClose() }) })
        : Promise.resolve()
      if (child.exitCode === null) child.kill('SIGTERM')
      await closed
      await new Promise<void>(resolveClose => provider.close(() => { resolveClose() }))
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY || notReady.length > 0)('web smoke (real host, real key)', () => {
  let child: ChildProcess
  let sessionsDir: string
  let baseUrl: string
  let browser: Browser
  let page: Page
  const pageErrors: string[] = []

  beforeAll(async () => {
    requireDist()
    sessionsDir = mkdtempSync(join(tmpdir(), 'dsh-web-w5-'))
    const port = await probeFreePort()
    // tsx boot mirrors the runtime half of the root dsh script. Isolate
    // the host-level Harness and shared-agent homes inside the temp world; tsx
    // also needs the repo's loader and tsconfig paths pointed at explicitly.
    const tsxLoader = pathToFileURL(createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx')).href
    child = spawn(
      process.execPath,
      [
        '--import', tsxLoader, join(REPO_ROOT, 'apps/cli/src/bin.ts'), 'web',
        // Launcher flags come first: the first token the launcher does not own
        // starts the web app's own arguments.
        // Pin the in-browser picker: the shipped `-auto` row would resolve to
        // the native OS chooser on this bind, and no page can drive that.
        '--patch', fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
        '--no-open',
        '--port', String(port),
      ],
      {
        cwd: sessionsDir,
        env: {
          ...process.env,
          DSH_HOME: join(sessionsDir, '.dsh'),
          DSH_AGENTS_HOME: join(sessionsDir, '.agents'),
          TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    baseUrl = (await waitForReadyLine(child)).replace('0.0.0.0', '127.0.0.1')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    page.on('pageerror', e => pageErrors.push(String(e)))
    await page.goto(baseUrl, { waitUntil: 'load' })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    if (child !== undefined && child.exitCode === null) {
      const gone = new Promise<void>(resolveExit => child.once('exit', () => { resolveExit() }))
      child.kill('SIGTERM')
      await Promise.race([gone, new Promise(r => setTimeout(r, 10_000).unref())])
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    if (sessionsDir !== undefined) rmSync(sessionsDir, { recursive: true, force: true })
  })

  it('cold start: loading page settles into the three-column frame', async () => {
    onTestFailed(() => saveFailureShot(page, 'w5-cold-start'))
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    expect(await page.locator('text=Failed to load plugins').count()).toBe(0)
    const template = await page.locator('[class*="frame"]').evaluate(el => getComputedStyle(el).gridTemplateColumns)
    expect(template.split(' ').length).toBe(3)
    await screen(page, '01-cold-start')
  })

  it('empty-state first send completes a real model round', async () => {
    onTestFailed(() => saveFailureShot(page, 'w5-first-round'))
    // This scenario spawns its own server against a fresh $DSH_HOME with the
    // DeepSeek credential inherited from the environment, so no onboarding
    // step mounts and the page is immediately interactive.
    // Fresh world: connect a Workspace so the composer starts live.
    await connectFreshWorkspace(page, sessionsDir)
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })
    const productTitle = await page.title()
    await screen(page, '02-empty-state')
    const prompt = `Please answer this request carefully: explain event sourcing in two sentences, ending with exactly ${ROUND_DONE_MARKER}.`
    await input.fill(prompt)
    await input.press('Enter')
    // The first send must keep the session tree mounted; a near-empty body
    // reveals a duplicate runtime bundle with incompatible scope tags.
    await page.waitForFunction(() => document.body.innerText.length > 50, undefined, { timeout: 15_000 })
    expect(pageErrors).toEqual([])
    await page.waitForFunction(
      expected => document.title !== expected && document.title.endsWith(` — ${expected}`),
      productTitle,
      { timeout: 15_000 },
    )
    await expect.poll(async () => (await remoteRpc<{ items: { sessionId: string }[] }>(
      baseUrl,
      'session/list',
      { _request: {} },
    )).items.length, {
      timeout: 15_000,
    }).toBe(1)
    const sessions = await remoteRpc<{ items: { sessionId: string }[] }>(
      baseUrl,
      'session/list',
      { _request: {} },
    )
    const sessionId = sessions.items[0]?.sessionId
    if (sessionId === undefined) throw new Error('created Web session was not listed')
    const durableTitle = await waitForProviderTitle(baseUrl, sessionId)
    await page.waitForFunction(
      ({ expected, product }) => document.title === `${expected} — ${product}`,
      { expected: durableTitle, product: productTitle },
      { timeout: 15_000 },
    )
    const sessionTree = page.getByRole('tree', { name: 'Sessions' })
    const projectRow = sessionTree.getByRole('treeitem').first()
    if (await projectRow.getAttribute('aria-expanded') === 'false') await projectRow.click()
    await Promise.all([
      sessionTree.getByText(durableTitle, { exact: true }).waitFor({ timeout: 10_000 }),
      page.getByRole('navigation').getByText(durableTitle, { exact: true }).waitFor({ timeout: 10_000 }),
    ])
    await waitForAssistantMarker(baseUrl, sessionId, ROUND_DONE_MARKER)
    await page.locator('p').filter({ hasText: ROUND_DONE_MARKER }).waitFor({ timeout: 10_000 })
    await screen(page, '04-round-complete')
  }, 150_000)

  it('view tabs: Chat and Trajectory switch', async () => {
    onTestFailed(() => saveFailureShot(page, 'w5-tabs'))
    await page.locator('button', { hasText: /Trajectory/i }).first().click()
    await screen(page, '05-trajectory-tab')
    await page.getByLabel('Trajectory timeline').waitFor()
    await expect.poll(() => page.getByRole('tab', { name: 'Waterfall' }).count()).toBe(0)
    await page.locator('button', { hasText: /^Chat$/i }).first().click()
    await screen(page, '07-back-to-chat')
  })

  it('bash differential rendering: tool row click leaves the default details column closed', async () => {
    onTestFailed(() => saveFailureShot(page, 'w5-tool-details'))
    const input = page.locator('[data-composer-input]').first()
    await input.fill('请用 bash 工具运行命令 echo w5marker 然后告诉我结果')
    await input.press('Enter')
    // Wait for the tool ROW, not response text (the reply echoes any marker).
    // Bash renders through the third-party sample registration. Match that
    // exact row: other clickable variants (for example Think disclosure)
    // may precede the tool call in document order.
    const toolRow = page.locator('[data-sample="bash"]')
    await toolRow.waitFor({ timeout: 120_000 })
    await screen(page, '08-bash-round')
    expect(await detailsTrack(page)).toBe(0)
    await toolRow.click()
    // Tool rows do not drive layout.openDetails; the default column stays closed.
    expect(await detailsTrack(page)).toBe(0)
    await screen(page, '09-details-closed')
  }, 150_000)

  it('sidebar drag widens the column and resets across reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'w5-drag'))
    const before = await firstTrack(page)
    const handle = page.locator('[class*="handle"]').first()
    const box = await handle.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 300)
    await page.mouse.down()
    await page.mouse.move(box!.x + 70, box!.y + 300, { steps: 6 })
    await page.mouse.up()
    const after = await firstTrack(page)
    expect(after).not.toBe(before)
    await screen(page, '10-sidebar-dragged')
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    expect(await firstTrack(page)).toBe(before)
  })

  it('dark mode: the body attribute cascades the token sheets', async () => {
    onTestFailed(() => saveFailureShot(page, 'w5-dark'))
    // The body attribute is the documented cascade mechanism; the Settings
    // gesture is owned by settings-chrome.e2e.ts — drive the attribute
    // directly here.
    const dark = await page.evaluate(() => {
      document.body.setAttribute('data-ds-dark-theme', '')
      return getComputedStyle(document.body).backgroundColor
    })
    await screen(page, '11-dark-mode')
    const light = await page.evaluate(() => {
      document.body.removeAttribute('data-ds-dark-theme')
      return getComputedStyle(document.body).backgroundColor
    })
    expect(dark).not.toBe(light)
  })

  it('reload recovery: history replays after a fresh boot', async () => {
    onTestFailed(() => saveFailureShot(page, 'w5-reload'))
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.locator('p').filter({ hasText: ROUND_DONE_MARKER }).waitFor({ timeout: 30_000 })
    await screen(page, '12-reload-recovery')
  })

  it('stayed clean: no page errors across every flow', () => {
    expect(pageErrors).toEqual([])
  })
})
