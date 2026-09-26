/** Keyless assembled-Web evidence for GitHub ready-for-review Session creation. */

import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-webhook'
import {
  captureExpandedTurnProcessAria,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const OVERLAY = fileURLToPath(new URL('../../cli/config/examples/github-review/cordis.yml', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/github-ready-review/conversation.expected.md', import.meta.url))
const EXPANDED_EXPECTED = fileURLToPath(
  new URL('./expected/github-ready-review/conversation-expanded.expected.md', import.meta.url),
)
const PROVIDER = 'github-webhook-review-test'
const MODEL = 'reply'
const SECRET = 'github-webhook-review-secret'
const TITLE = 'Review deepseek-ai/deepseek-harness#314'
const REPLY = 'Review complete: no actionable findings.'

/** Deterministic model response for the webhook-created Session. */
class ReviewAdapter extends LlmAdapter {
  override async listModels(provider: string) { return [{ provider, id: MODEL, name: `${provider}/${MODEL}` }] }
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: REPLY } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Reserve one currently free loopback port for the isolated WebServer. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>(resolve => server.close(() => { resolve() }))
  return port
}

/** Sign one exact GitHub JSON body. */
function signature(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`
}

/** Send one signed GitHub delivery to a selected origin. */
async function send(origin: string, delivery: string, body: object, event = 'pull_request'): Promise<Response> {
  const text = JSON.stringify(body)
  return await fetch(`${origin}/github`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signature(text),
      'x-github-event': event,
      'x-github-delivery': delivery,
    },
    body: text,
  })
}

describe.skipIf(MODE === 'record')('web e2e: GitHub ready-for-review', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let webhookOrigin: string
  let tripwire: ReturnType<typeof watchConsole>
  let previousPort: string | undefined
  let previousSecret: string | undefined
  const adapter = new ReviewAdapter()

  beforeAll(async () => {
    previousPort = process.env.DSH_GITHUB_WEBHOOK_PORT
    previousSecret = process.env.DSH_GITHUB_WEBHOOK_SECRET
    const port = await freePort()
    process.env.DSH_GITHUB_WEBHOOK_PORT = String(port)
    process.env.DSH_GITHUB_WEBHOOK_SECRET = SECRET
    webhookOrigin = `http://127.0.0.1:${String(port)}`
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    scaffold.ctx.effect(
      () => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter),
      'GitHub webhook review adapter',
    )
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })

    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    await page.addInitScript(() => { localStorage.setItem('dsh.locale', 'en') })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (previousPort === undefined) Reflect.deleteProperty(process.env, 'DSH_GITHUB_WEBHOOK_PORT')
    else process.env.DSH_GITHUB_WEBHOOK_PORT = previousPort
    if (previousSecret === undefined) Reflect.deleteProperty(process.env, 'DSH_GITHUB_WEBHOOK_SECRET')
    else process.env.DSH_GITHUB_WEBHOOK_SECRET = previousSecret
  })

  it('isolates ingress and creates a browsable Workspace Session', async () => {
    onTestFailed(async () => { await saveFailureShot(page, 'github-ready-review') })
    const before = scaffold.ctx.agents.list().length

    expect((await fetch(`${webhookOrigin}/api`)).status).toBe(404)
    expect((await send(scaffold.baseUrl, 'wrong-port', { zen: 'ping' }, 'ping')).status).not.toBe(202)
    expect(scaffold.ctx.agents.list()).toHaveLength(before)

    expect((await send(webhookOrigin, 'ping', { zen: 'keep it logically awesome' }, 'ping')).status).toBe(202)
    await vi.waitFor(() => { expect(scaffold.ctx.agents.list()).toHaveLength(before) })

    const payload = {
      action: 'ready_for_review',
      number: 314,
      repository: { full_name: 'deepseek-ai/deepseek-harness' },
      pull_request: {
        title: 'Fix session replay',
        html_url: 'https://github.com/deepseek-ai/deepseek-harness/pull/314',
        draft: false,
        user: { login: 'octocat' },
        base: { ref: 'master', sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        head: { ref: 'fix-session-replay', sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      },
    }
    const completed = Promise.withResolvers<undefined>()
    let reviewSession: string | undefined
    const off = scaffold.ctx.on('session/event', (session, event) => {
      if (event.type === 'user/message' && event.data.source.kind === 'webhook'
        && event.data.source.provider === 'github' && event.data.source.source === 'primary-github'
        && event.data.source.deliveryId === 'ready' && event.data.source.ruleId === 'review-pr-when-ready') reviewSession = session.id
      if (event.type === 'turn/end' && session.id === reviewSession) completed.resolve(undefined)
    })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const createWorkspace = scaffold.ctx.workspaceRegistry.create.bind(scaffold.ctx.workspaceRegistry)
    const create = vi.spyOn(scaffold.ctx.workspaceRegistry, 'create').mockImplementationOnce(async (...args) => {
      entered.resolve(undefined)
      await release.promise
      return await createWorkspace(...args)
    })
    onTestFinished(() => {
      off()
      release.resolve(undefined)
      create.mockRestore()
    })
    try {
      expect((await send(webhookOrigin, 'ready', payload)).status).toBe(202)
      await entered.promise
      expect(scaffold.ctx.agents.list()).toHaveLength(before)
      expect(adapter.requests).toHaveLength(0)
      release.resolve(undefined)
      await completed.promise
    } finally {
      release.resolve(undefined)
      create.mockRestore()
      off()
    }
    expect(scaffold.ctx.agents.list()).toHaveLength(before + 1)
    expect(adapter.requests).toHaveLength(1)

    const agent = scaffold.ctx.agents.list().find(candidate => candidate.session.header.cwd === scaffold.workspaceCwd)
    expect(agent).toBeDefined()
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(scaffold.workspaceCwd)
    expect(workspace?.sessionIds).toContain(agent?.id)
    const webhookMessage = adapter.requests[0]?.messages.find(message => message.role === 'user' && message.source?.kind === 'webhook')
    expect(webhookMessage?.content).toHaveLength(1)
    const [content] = webhookMessage?.content ?? []
    expect(content?.type).toBe('text')
    if (content?.type !== 'text') throw new Error('webhook prompt was not text')
    expect(content.text).toContain('exact head SHA bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')

    const workspaceRow = page.locator('[role="treeitem"]').first()
    if (await workspaceRow.getAttribute('aria-expanded') !== 'true') await workspaceRow.click()
    await page.getByText(TITLE, { exact: true }).click()
    await page.getByText(REPLY, { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    const tree = await captureStableAria(page, '[role="tree"][aria-label="Sessions"]', scaffold.workspaceCwd)
    const conversation = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(EXPECTED, `${tree}\n\n---\n\n${conversation}`, MODE)
    const expanded = await captureExpandedTurnProcessAria(
      page,
      '[class*="centerCol"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(EXPANDED_EXPECTED, `${tree}\n\n---\n\n${expanded}`, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)
})
