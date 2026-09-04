/** Real CLI and DeepSeek evidence for a GitHub webhook-created Session. */

import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const BUILT_BIN = join(REPO_ROOT, 'apps/cli/lib/bin.js')
const OVERLAY = fileURLToPath(new URL(
  './fixtures/github-webhook/cordis.yml',
  import.meta.url,
))
const SECRET = 'github-webhook-real-e2e-secret'
const DELIVERY = 'github-webhook-real-e2e-delivery'
const MARKER = 'DSH_GITHUB_WEBHOOK_REAL_E2E_OK'
const TITLE = 'GitHub webhook real e2e'
const authenticatedCookies = new Map<string, Promise<{ origin: string; cookie: string }>>()

/** Exchange the printed process token once for Node-side API probes. */
function authenticatedWeb(launchUrl: string): Promise<{ origin: string; cookie: string }> {
  const existing = authenticatedCookies.get(launchUrl)
  if (existing !== undefined) return existing
  const exchange = (async () => {
    const response = await fetch(launchUrl, { redirect: 'manual' })
    const setCookie = response.headers.get('set-cookie')
    if (response.status !== 303 || setCookie === null) {
      throw new Error(`dsh web authentication returned HTTP ${String(response.status)}`)
    }
    return { origin: new URL(launchUrl).origin, cookie: setCookie.split(';', 1)[0]! }
  })()
  authenticatedCookies.set(launchUrl, exchange)
  return exchange
}

interface SessionList {
  items: Array<{
    sessionId: string
    cwd?: string
    blank: boolean
    projections?: { values: { agentPreset?: string | null } }
  }>
}

interface WorkspaceBaseline {
  items: Array<{
    path: string
    sessionIds: string[]
  }>
}

interface HistoryPage {
  records: Array<{ type: 'event'; event: HistoryEvent }>
  hasMore: boolean
}

interface HistoryEvent {
  type: string
  data: unknown
}

interface ProcessObservation {
  readonly ready: Promise<string>
  readonly text: () => string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Capture bounded process output and resolve the public Web URL after settled boot. */
function observeProcess(child: ChildProcess): ProcessObservation {
  let output = ''
  let settled = false
  let resolveReady!: (url: string) => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<string>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const timer = setTimeout(() => {
    if (!settled) rejectReady(new Error(`dsh web did not become ready within 90s:\n${output}`))
  }, 90_000)
  timer.unref()
  const append = (chunk: Buffer | string): void => {
    output = `${output}${String(chunk)}`.slice(-100_000)
    const match = /dsh web: (http:\/\/[^\s]+)/u.exec(output)
    if (settled || match?.[1] === undefined) return
    settled = true
    clearTimeout(timer)
    resolveReady(match[1].replace('0.0.0.0', '127.0.0.1'))
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  child.once('error', (error) => {
    if (!settled) rejectReady(error)
  })
  child.once('exit', (code) => {
    if (!settled) rejectReady(new Error(`dsh web exited before readiness (code ${String(code)}):\n${output}`))
  })
  return { ready, text: () => output }
}

/** Reserve and release one loopback port for the isolated webhook listener. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
  return port
}

/** Invoke one public Remote method over its HTTP carrier. */
async function remoteRpc<T>(baseUrl: string, endpoint: string, args: object): Promise<T> {
  const authenticated = await authenticatedWeb(baseUrl)
  const response = await fetch(`${authenticated.origin}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: authenticated.cookie },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `github-webhook-real-${endpoint}-${randomUUID()}`,
      method: endpoint,
      payload: { args },
    }),
  })
  if (!response.ok) {
    throw new Error(`${endpoint} returned HTTP ${String(response.status)}: ${await response.text()}`)
  }
  const envelope = await response.json() as {
    result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
  }
  if (!envelope.result.ok) {
    throw new Error(`${endpoint} failed: ${envelope.result.error.code}: ${envelope.result.error.message}`)
  }
  return envelope.result.value
}

/** Read one opening item from a public Remote stream. */
async function openingStreamItem(
  baseUrl: string,
  endpoint: string,
  args: object,
  accepts: (value: unknown) => boolean,
): Promise<Record<string, unknown>> {
  const authenticated = await authenticatedWeb(baseUrl)
  const socket = new WebSocket(`${authenticated.origin.replace(/^http/u, 'ws')}/api/remote.mux`, {
    headers: { cookie: authenticated.cookie },
  })
  const streamId = `github-webhook-real-${endpoint}-${randomUUID()}`
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
        reject(new Error(`${endpoint} carrier failed before opening`))
      }
      const closed = (): void => {
        cleanup()
        reject(new Error(`${endpoint} carrier closed before opening`))
      }
      socket.addEventListener('open', opened)
      socket.addEventListener('error', failed)
      socket.addEventListener('close', closed)
    })
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { finish(new Error(`${endpoint} did not publish its opening item`)) }, 10_000)
      const cleanup = (): void => {
        clearTimeout(timer)
        socket.removeEventListener('message', message)
        socket.removeEventListener('error', failed)
        socket.removeEventListener('close', closed)
      }
      const finish = (error: Error | undefined, value?: Record<string, unknown>): void => {
        cleanup()
        if (error !== undefined) reject(error)
        else if (value === undefined) reject(new Error(`${endpoint} opening item was absent`))
        else resolve(value)
      }
      const message = (event: WebSocket.MessageEvent): void => {
        try {
          const text = typeof event.data === 'string'
            ? event.data
            : Buffer.isBuffer(event.data) ? event.data.toString('utf8') : undefined
          if (text === undefined) throw new Error(`${endpoint} published a non-text frame`)
          const frame: unknown = JSON.parse(text)
          if (!isRecord(frame) || frame.streamId !== streamId) return
          if (frame.type === 'error') {
            finish(new Error(`${endpoint} failed: ${JSON.stringify(frame.error)}`))
            return
          }
          if (frame.type === 'end') {
            finish(new Error(`${endpoint} ended before its opening item`))
            return
          }
          if (frame.type === 'item' && isRecord(frame.value) && accepts(frame.value)) {
            finish(undefined, frame.value)
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      }
      const failed = (): void => { finish(new Error(`${endpoint} carrier failed before its opening item`)) }
      const closed = (): void => { finish(new Error(`${endpoint} carrier closed before its opening item`)) }
      socket.addEventListener('message', message)
      socket.addEventListener('error', failed)
      socket.addEventListener('close', closed)
      socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
    })
  } finally {
    socket.close()
  }
}

/** Read the current Workspace baseline from a fresh follow generation. */
async function workspaceBaseline(baseUrl: string): Promise<WorkspaceBaseline> {
  const frame = await openingStreamItem(
    baseUrl,
    'workspace/follow',
    {},
    value => isRecord(value) && value.type === 'baseline' && isRecord(value.value),
  )
  return frame.value as WorkspaceBaseline
}

/** Read the complete opening page from a fresh Session follow generation. */
async function history(baseUrl: string, sessionId: string): Promise<HistoryPage> {
  const frame = await openingStreamItem(
    baseUrl,
    'session/follow',
    { request: { address: { kind: 'session', sessionId }, maxMessages: 100 } },
    value => isRecord(value)
      && value.type === 'snapshot'
      && Array.isArray(value.records)
      && typeof value.hasMore === 'boolean',
  )
  return { records: frame.records as HistoryPage['records'], hasMore: frame.hasMore as boolean }
}

/** Poll a public observation until it satisfies the test's behavior predicate. */
async function eventually<T>(
  child: ChildProcess,
  processOutput: () => string,
  label: string,
  probe: () => Promise<T>,
  accepts: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastValue: T | undefined
  let lastError: unknown
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`dsh web exited while waiting for ${label} (code ${String(child.exitCode)}):\n${processOutput()}`)
    }
    try {
      lastValue = await probe()
      if (accepts(lastValue)) return lastValue
    } catch (error) {
      lastError = error
    }
    await delay(300)
  }
  throw new Error(
    `timed out waiting for ${label}; last value=${JSON.stringify(lastValue)}; `
    + `last error=${String(lastError)}; process output:\n${processOutput()}`,
  )
}

/** Return every text block from durable assistant messages. */
function assistantText(page: HistoryPage): string {
  const text: string[] = []
  for (const event of historyEvents(page)) {
    if (event.type !== 'assistant/message' || !isRecord(event.data) || !isRecord(event.data.message)) continue
    const content = event.data.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') text.push(block.text)
    }
  }
  return text.join('\n')
}

/** Read scalar v2 history records for assertions over the public event stream. */
function historyEvents(page: HistoryPage): HistoryEvent[] {
  return page.records.map(record => record.event)
}

/** Stop the spawned CLI through its normal signal path, escalating only on a stuck teardown. */
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve })
  child.once('close', resolveClosed)
  child.kill('SIGTERM')
  if (await Promise.race([closed.then(() => true), delay(10_000, false, { ref: false })])) return
  if (child.exitCode === null) child.kill('SIGKILL')
  await Promise.race([closed, delay(5_000, undefined, { ref: false })])
}

/** Send the sole synthetic external interaction: one signed GitHub delivery. */
async function sendGitHubDelivery(origin: string): Promise<Response> {
  const body = JSON.stringify({
    action: 'ready_for_review',
    number: 4242,
    repository: { full_name: 'deepseek-harness/deepseek-harness' },
    pull_request: {
      title: 'Real CLI webhook e2e',
      html_url: 'https://github.com/deepseek-harness/deepseek-harness/pull/4242',
      draft: false,
      user: { login: 'octocat' },
      base: { ref: 'master', sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      head: { ref: 'webhook-e2e', sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    },
  })
  const signature = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`
  return await fetch(`${origin}/github`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': DELIVERY,
      'x-github-event': 'pull_request',
      'x-hub-signature-256': signature,
    },
    body,
  })
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('GitHub webhook through the real dsh CLI and model', () => {
  it('creates, attaches, prompts, and completes a Workspace Session', async () => {
    expect(existsSync(BUILT_BIN), `missing built CLI ${BUILT_BIN}; run pnpm run build:official`).toBe(true)
    const root = await mkdtemp(join(tmpdir(), 'dsh-github-webhook-real-'))
    const workspacePath = join(root, 'workspace')
    await mkdir(workspacePath)
    const canonicalWorkspacePath = await realpath(workspacePath)
    const webhookPort = await freePort()
    const child = spawn(process.execPath, [
      BUILT_BIN,
      'web',
      '--patch', OVERLAY,
      '--no-open',
      '--host', '127.0.0.1',
      '--port', '0',
    ], {
      cwd: root,
      env: {
        ...process.env,
        DSH_AGENTS_HOME: join(root, '.agents'),
        DSH_GITHUB_E2E_MARKER: MARKER,
        DSH_GITHUB_E2E_WORKSPACE: workspacePath,
        DSH_GITHUB_WEBHOOK_PORT: String(webhookPort),
        DSH_GITHUB_WEBHOOK_SECRET: SECRET,
        DSH_HOME: join(root, '.dsh'),
        DSH_TELEMETRY_DISABLED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const observation = observeProcess(child)

    try {
      const baseUrl = await observation.ready
      const webhookOrigin = `http://127.0.0.1:${String(webhookPort)}`

      expect((await fetch(`${webhookOrigin}/api`)).status).toBe(404)
      expect((await sendGitHubDelivery(new URL(baseUrl).origin)).status).not.toBe(202)
      expect((await sendGitHubDelivery(webhookOrigin)).status).toBe(202)

      const workspaces = await eventually(
        child,
        observation.text,
        'one Workspace-attached Session',
        async () => await workspaceBaseline(baseUrl),
        value => value.items.some(workspace =>
          workspace.path === canonicalWorkspacePath && workspace.sessionIds.length === 1),
        30_000,
      )
      const workspace = workspaces.items.find(item => item.path === canonicalWorkspacePath)
      const sessionId = workspace?.sessionIds[0]
      if (sessionId === undefined) throw new Error('workspace/follow did not expose the webhook Session')

      const sessions = await remoteRpc<SessionList>(baseUrl, 'session/list', { _request: {} })
      expect(sessions.items.find(session => session.sessionId === sessionId)).toMatchObject({
        blank: false,
        cwd: canonicalWorkspacePath,
        projections: { values: { agentPreset: 'minimal' } },
      })

      const admitted = await eventually(
        child,
        observation.text,
        'webhook provenance, title, and permission events',
        async () => await history(baseUrl, sessionId),
        (page) => {
          const events = historyEvents(page)
          const title = events.find(event => event.type === 'session/title')
          const permission = events.find(event =>
            event.type === 'permission/preset'
            && isRecord(event.data)
            && event.data.preset === 'read-only')
          const message = events.find(event =>
            event.type === 'user/message'
            && isRecord(event.data)
            && isRecord(event.data.source)
            && event.data.source.kind === 'webhook')
          return isRecord(title?.data) && title.data.title === TITLE
            && permission !== undefined
            && isRecord(message?.data) && isRecord(message.data.source)
            && message.data.source.provider === 'github'
            && message.data.source.deliveryId === DELIVERY
        },
        30_000,
      )
      const webhookMessage = historyEvents(admitted)
        .find(event => event.type === 'user/message'
          && isRecord(event.data)
          && isRecord(event.data.source)
          && event.data.source.kind === 'webhook')
      expect(webhookMessage?.data).toMatchObject({
        content: [{ type: 'text', text: `Reply with exactly ${MARKER} and no other text. Do not call tools.` }],
        source: {
          kind: 'webhook',
          provider: 'github',
          deliveryId: DELIVERY,
          ruleId: 'github-real-e2e',
          source: 'github-real-e2e',
        },
      })

      const completed = await eventually(
        child,
        observation.text,
        'a real DeepSeek assistant response',
        async () => await history(baseUrl, sessionId),
        page => assistantText(page).includes(MARKER),
        150_000,
      )
      expect(assistantText(completed)).toContain(MARKER)
    } finally {
      await stop(child)
      await rm(root, { recursive: true, force: true })
    }
  }, 330_000)
})
