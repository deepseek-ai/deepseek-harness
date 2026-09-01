// Web e2e scenario: absolute HTTP(S) Markdown images. A validated session
// assembled through the Session API is seeded cold into the real web
// composition, then a separate image origin proves that the browser receives
// a real network image while local-path Markdown remains inert alt text.
import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  seedSession,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/markdown-images', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./expected/markdown-images/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'markdown-images-web-e2e'
const REMOTE_ALT = 'Remote test image'
const LOCAL_ALT = 'Local test image'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

interface ImageOrigin {
  server: Server
  url: string
  requests: Array<{ path: string | undefined; referer: string | undefined }>
}

/** Start the deterministic remote image origin used by this browser scenario. */
async function startImageOrigin(): Promise<ImageOrigin> {
  const requests: ImageOrigin['requests'] = []
  const server = createServer((request, response) => {
    requests.push({ path: request.url, referer: request.headers.referer })
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-length': PNG.length,
      'content-type': 'image/png',
    })
    response.end(PNG)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('image origin did not expose an IP socket')
  }
  return {
    server,
    url: `http://127.0.0.1:${String(address.port)}/image.png`,
    requests,
  }
}

/** Stop one image origin after the browser and host release their requests. */
async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
}

/** Build one closed, invariant-checked session fixture with remote and local image Markdown. */
function markdownImageFixture(remoteUrl: string): string {
  const session = Session.create(SessionId('markdown-image-source'))
  const eventTimeOrigin = new Date().setHours(12, 0, 0, 0)
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Show the Markdown image policy.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title: 'Markdown image policy',
    messageSeqs: [user.seq],
    source: { kind: 'fallback' },
  })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{
        type: 'text',
        text: [
          '## Markdown images',
          '',
          `![${REMOTE_ALT}](${remoteUrl})`,
          '',
          `![${LOCAL_ALT}](./local-image.png)`,
          '',
          'REMOTE_IMAGE_DONE',
        ].join('\n'),
      }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const header = {
    type: 'session',
    version: SESSION_FORMAT_VERSION,
    id: '{{sessionId}}',
    createdAt: 0,
    cwd: '{{cwd}}',
  }
  return [
    JSON.stringify(header),
    // Spaced event times, exactly as the sibling markdown fixtures pin them:
    // the stats line renders its LLM segment only while the step's measured
    // milliseconds exceed zero, so a fixture that leaves the times unset lets
    // the replay's own speed decide whether the golden matches.
    ...session.snapshotEvents().map(event => JSON.stringify({
      ...event,
      time: eventTimeOrigin + event.seq * 1_000,
    })),
    '',
  ].join('\n')
}

describe('web e2e: remote Markdown image rendering', () => {
  let scaffold: WebScaffold
  let imageOrigin: ImageOrigin
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    imageOrigin = await startImageOrigin()
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, markdownImageFixture(imageOrigin.url), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await stopServer(imageOrigin.server)
  })

  it.skipIf(MODE === 'record')('loads only the remote image and matches the conversation golden', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-markdown-images'))
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await expect.poll(() => page.getByText('REMOTE_IMAGE_DONE', { exact: true }).count(), {
      timeout: 15_000,
    }).toBe(1)

    const image = page.getByRole('img', { name: REMOTE_ALT })
    await image.waitFor({ timeout: 10_000 })
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth), {
      timeout: 10_000,
    }).toBeGreaterThan(0)
    expect(await image.evaluate((element) => {
      const computed = getComputedStyle(element)
      return {
        borderRadius: computed.borderRadius,
        decoding: element.getAttribute('decoding'),
        loading: element.getAttribute('loading'),
        maxWidth: computed.maxWidth,
        referrerPolicy: element.getAttribute('referrerpolicy'),
      }
    })).toEqual({
      borderRadius: '8px',
      decoding: 'async',
      loading: 'lazy',
      maxWidth: '100%',
      referrerPolicy: 'no-referrer',
    })
    expect(await page.getByRole('img', { name: LOCAL_ALT }).count()).toBe(0)
    expect(await page.getByText(LOCAL_ALT, { exact: true }).count()).toBe(1)
    expect(imageOrigin.requests).toEqual([{ path: '/image.png', referer: undefined }])

    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  }, 60_000)
})
