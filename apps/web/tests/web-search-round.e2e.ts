// Web e2e scenario for the shipped default search composition. A real browser
// drives `web_search`; the model stream is replayed while the real DeepSeek
// provider calls a deterministic local Anthropic-compatible endpoint through
// the real credentials service.
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { WEB_SEARCH_MAX_RESULTS } from '@deepseek-ai/dsh-tool-web'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, expandOwningTurnProcess, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/web-search-round', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/web-search-round/session.v2.jsonl', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/web-search-round/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const QUERIES = ['DeepSeek Harness snapshot search', 'DeepSeek Harness multi-query search'] as const
const PROMPT = `Use web_search once with queries ${JSON.stringify(QUERIES)}. Then reply exactly SEARCH_DONE and stop.`
const SEARCH_CREDENTIAL_REF = credentialRef('DSH_WEB_SEARCH_E2E_KEY')
const SEARCH_CREDENTIAL = 'snapshot-search-key'

/**
 * Provider results the double returns per query. The combined result exceeds
 * the shipped `searchMaxResults`, so the tool's round-robin cap and the card's
 * scroll container are both exercised. Each row carries a title, a snippet,
 * and a date, so 8 kept rows exceed the `.sources` 320px max-height.
 */
const PROVIDER_RESULT_COUNT = 6

/** One provider result's URL, by 1-based provider order. */
function resultUrl(queryIndex: number, ordinal: number): string {
  return `https://docs.example.test/search/${queryIndex + 1}/${ordinal}`
}

/** One provider result's title, by 1-based provider order. */
function resultTitle(queryIndex: number, ordinal: number): string {
  return `Snapshot Search ${queryIndex + 1} Result ${ordinal}`
}

/** One provider result's citation excerpt, by 1-based provider order. */
function resultSnippet(queryIndex: number, ordinal: number): string {
  return `Snapshot search ${queryIndex + 1} excerpt ${ordinal}: the harness replays this source list from a local endpoint.`
}

/** One provider result's `page_age`, by 1-based provider order (July 2026 days 01..12). */
function resultPageAge(ordinal: number): string {
  return `2026-07-${String(ordinal).padStart(2, '0')}`
}

/** The 1-based provider ordinals, in provider order. */
const RESULT_ORDINALS = Array.from({ length: PROVIDER_RESULT_COUNT }, (_value, index) => index + 1)

/** Sources kept after round-robin merging reaches the shipped combined cap. */
const KEPT_SOURCES = RESULT_ORDINALS.flatMap(ordinal => QUERIES.map((_query, queryIndex) => ({
  url: resultUrl(queryIndex, ordinal),
  title: resultTitle(queryIndex, ordinal),
  snippet: resultSnippet(queryIndex, ordinal),
  publishedAt: resultPageAge(ordinal),
}))).slice(0, WEB_SEARCH_MAX_RESULTS)

/** URLs omitted after the combined source cap is reached. */
const DROPPED_SOURCE_URLS = RESULT_ORDINALS.flatMap(ordinal => QUERIES.map(
  (_query, queryIndex) => resultUrl(queryIndex, ordinal),
)).slice(WEB_SEARCH_MAX_RESULTS)

interface CapturedSearchRequest {
  path: string
  apiKey: string | undefined
  body: unknown
}

/** Start the deterministic DeepSeek Messages double used by the real provider. */
async function startSearchServer(captured: CapturedSearchRequest[]): Promise<{ server: Server; baseURL: string }> {
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const parsedBody = JSON.parse(body) as unknown
      captured.push({
        path: request.url ?? '',
        apiKey: typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : undefined,
        body: parsedBody,
      })
      const serializedBody = JSON.stringify(parsedBody)
      const queryIndex = QUERIES.findIndex(query => serializedBody.includes(`Perform a web search for the query: ${query}`))
      if (queryIndex < 0) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'unknown fixture query' }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        content: [
          {
            type: 'text',
            text: `Found ${PROVIDER_RESULT_COUNT} sources.`,
            citations: RESULT_ORDINALS.map(ordinal => ({
              type: 'web_search_result_location',
              url: resultUrl(queryIndex, ordinal),
              cited_text: resultSnippet(queryIndex, ordinal),
            })),
          },
          {
            type: 'web_search_tool_result',
            content: RESULT_ORDINALS.map(ordinal => ({
              type: 'web_search_result',
              url: resultUrl(queryIndex, ordinal),
              title: resultTitle(queryIndex, ordinal),
              page_age: resultPageAge(ordinal),
            })),
          },
        ],
      }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return { server, baseURL: `http://127.0.0.1:${address.port}` }
}

describe('web e2e: shipped default web search', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let searchServer: Server | undefined
  let searchBaseURL: string
  let tripwire: ReturnType<typeof watchConsole>
  const searchRequests: CapturedSearchRequest[] = []
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    const search = await startSearchServer(searchRequests)
    searchServer = search.server
    searchBaseURL = search.baseURL
    scaffold = await launchWebScaffold({
      compareReplaySession: true,
      deepSeekSearch: {
        baseURL: search.baseURL,
        apiKeyEnv: SEARCH_CREDENTIAL_REF,
      },
      ...(MODE === 'record' ? {} : { replayFixture: FIXTURE, paceMs: 15 }),
    })
    await scaffold.ctx.credentials.set(SEARCH_CREDENTIAL_REF, SEARCH_CREDENTIAL)
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await new Promise<void>((resolve, reject) => {
      if (searchServer === undefined) {
        resolve()
        return
      }
      searchServer.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
  })

  it('drives the recorded search to a settled turn (all modes)', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-search-drive'))
    if (MODE !== 'record') {
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    }
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled()
    await input.fill(PROMPT)
    await input.press('Enter')
    const sessionId = await settled
    if (MODE === 'record') await recordFixture(scaffold, sessionId, FIXTURE)
  }, 200_000)

  it.skipIf(MODE === 'record')('uses the real provider and persists the capped structured result', () => {
    expect(searchRequests).toHaveLength(QUERIES.length)
    for (const query of QUERIES) {
      const request = searchRequests.find(candidate => JSON.stringify(candidate.body).includes(query))
      if (request === undefined) throw new Error(`missing provider request for query: ${query}`)
      expect(request).toMatchObject({ path: '/messages', apiKey: SEARCH_CREDENTIAL })
      expect(request.body).toMatchObject({
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }],
        }],
      })
      const tools = (request.body as { tools?: unknown }).tools
      expect(tools).toHaveLength(1)
      expect((tools as unknown[])[0]).toMatchObject({ type: 'web_search_20250305', name: 'web_search' })
    }

    const auxiliaryRequests = sessionEvents.filter(
      (event): event is Extract<SessionEvent, { type: 'web/deepseek-search-llm-request' }> =>
        event.type === 'web/deepseek-search-llm-request',
    )
    expect(auxiliaryRequests).toHaveLength(QUERIES.length)
    for (const query of QUERIES) {
      const request = searchRequests.find(candidate => JSON.stringify(candidate.body).includes(query))
      const auxiliaryRequest = auxiliaryRequests.find(event => JSON.stringify(event.data.body).includes(query))
      if (request === undefined || auxiliaryRequest === undefined) {
        throw new Error(`missing paired provider request for query: ${query}`)
      }
      expect(auxiliaryRequest.data).toEqual({
        endpoint: `${searchBaseURL}/messages`,
        apiVersion: '2023-06-01',
        body: request.body,
      })
    }

    const searchCall = sessionEvents.find(
      (event): event is Extract<SessionEvent, { type: 'tool/call' }> =>
        event.type === 'tool/call' && event.data.name === 'web_search',
    )
    if (searchCall === undefined) throw new Error('the replayed turn did not call web_search')
    const searchResult = sessionEvents.find(
      (event): event is Extract<SessionEvent, { type: 'tool/result' }> =>
        event.type === 'tool/result' && event.data.message.source.callId === searchCall.data.callId,
    )
    if (searchResult === undefined) throw new Error('web_search produced no durable result')
    const content = searchResult.data.message.content[0]
    expect(content.isError).toBe(false)
    const rendered = content.content.filter(block => block.type === 'text').map(block => block.text).join('')
    // The tool interleaves sources from both seam results before applying the
    // combined cap, so each query remains represented in model-visible output.
    for (const source of KEPT_SOURCES) {
      expect(rendered).toContain(`[${source.title}](${source.url})`)
    }
    for (const url of DROPPED_SOURCE_URLS) {
      expect(rendered).not.toContain(url)
    }
    expect(rendered).toContain(
      `(Showing the first ${WEB_SEARCH_MAX_RESULTS} sources. Refine the query for more.)`,
    )
    expect(searchResult.data.meta).toMatchObject({
      sources: KEPT_SOURCES,
      truncated: true,
    })
  })

  it.skipIf(MODE === 'record')('matches the settled search card aria golden', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-search-aria'))
    await expect.poll(() => page.getByText('SEARCH_DONE', { exact: true }).count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1)
    const searchTool = page.locator('[data-tool="web_search"]')
    await expandOwningTurnProcess(page, searchTool)
    await searchTool.waitFor({ timeout: 10_000 })
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
  })

  it.skipIf(MODE === 'record')('scrolls the capped source list inside the fixed-height container', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-search-sources-scroll'))
    const row = page.locator('[data-tool="web_search"] [data-expandable]').first()
    await expandOwningTurnProcess(page, row)
    await row.click()
    await expect.poll(() => row.getAttribute('aria-expanded'), { timeout: 5_000 }).toBe('true')

    const card = page.locator('[data-web="search"]')
    const sources = card.locator('ol')
    await sources.waitFor({ timeout: 10_000 })
    // The card draws exactly the sources the model saw after the combined cap.
    expect(await sources.locator('li').count()).toBe(WEB_SEARCH_MAX_RESULTS)
    // The list is complete in the DOM, so the card carries no expand control.
    expect(await card.locator('button').count()).toBe(0)
    expect(await card.getByText('Source list truncated').isVisible()).toBe(true)

    const geometry = await sources.evaluate((element) => {
      const computed = getComputedStyle(element)
      return {
        maxHeight: computed.maxHeight,
        overflowY: computed.overflowY,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }
    })
    expect(geometry.maxHeight).toBe('320px')
    expect(geometry.overflowY).toBe('auto')
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight)
  })

  it.skipIf(MODE === 'record')('reserves marker room a scroll container cannot clip back', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-search-marker-room'))
    await expandOwningTurnProcess(page, page.locator('[data-tool="web_search"]'))
    // `overflow-y: auto` clips inline-start overflow with no way to scroll it
    // back, and markers are right-aligned to the content edge, so a marker wider
    // than `padding-left` silently loses its leading digits. `searchMaxResults`
    // is an unbounded positive integer, so measure the widest three-digit marker
    // in the list's own font and require the shipped padding to hold it.
    const marker = await page.locator('[data-web="search"] ol').evaluate((element) => {
      const probe = document.createElement('span')
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:inherit'
      probe.textContent = '999. '
      element.append(probe)
      const widest = probe.getBoundingClientRect().width
      probe.remove()
      return { widest, paddingLeft: parseFloat(getComputedStyle(element).paddingLeft) }
    })
    expect(marker.paddingLeft).toBeGreaterThanOrEqual(marker.widest)
  })

  it.skipIf(MODE === 'record')('stayed clean and kept the exact fixture inventory', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v2.jsonl', 'ui.expected.md'])
  })
})
