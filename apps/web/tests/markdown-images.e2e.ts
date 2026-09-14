// Real browser image loading and failure fallbacks through the shipped Web composition.
import { open, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
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
const WORKSPACE_ALT = 'Workspace test image'
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
function markdownImageFixture(remoteUrl: string, outsidePath: string): string {
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
    stream: [],
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
          `![${WORKSPACE_ALT}]({{cwd}}/valid.png)`,
          '',
          '![Oversized image]({{cwd}}/oversized.png)',
          '',
          `![Outside workspace image](${outsidePath})`,
          '',
          '![Missing image]({{cwd}}/missing.png)',
          '',
          '![]({{cwd}}/corrupt.png)',
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
    isSeeded: false,
    delegationDepth: 0,
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

describe('web e2e: Markdown image rendering', () => {
  let scaffold: WebScaffold
  let imageOrigin: ImageOrigin
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const mediaResponses = new Map<string, number>()

  beforeAll(async () => {
    imageOrigin = await startImageOrigin()
    scaffold = await launchWebScaffold({})
    await writeFile(join(scaffold.workspaceCwd, 'valid.png'), PNG)
    await writeFile(join(scaffold.workspaceCwd, 'corrupt.png'), 'invalid image')
    const oversized = await open(join(scaffold.workspaceCwd, 'oversized.png'), 'w')
    try {
      await oversized.truncate(20 * 1024 * 1024 + 1)
    } finally {
      await oversized.close()
    }
    const outsidePath = join(scaffold.persistenceRoot, 'outside.png')
    await writeFile(outsidePath, PNG)
    await writeFile(join(scaffold.workspaceCwd, 'active.html'), '<p>File preview</p><script>document.body.dataset.scriptRan = "yes"</script>')
    await seedSession(scaffold, markdownImageFixture(imageOrigin.url, outsidePath), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    page.on('response', (response) => {
      const url = new URL(response.url())
      if (url.pathname !== '/api/file') return
      const path = url.searchParams.get('path')
      if (path !== null) mediaResponses.set(path, response.status())
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (imageOrigin !== undefined) await stopServer(imageOrigin.server)
  })

  it('authenticates file requests and isolates directly opened active content', async () => {
    const path = `/api/file?path=${encodeURIComponent(join(scaffold.workspaceCwd, 'active.html'))}`
    const unauthenticated = await fetch(new URL(path, scaffold.baseUrl))
    expect(unauthenticated.status).toBe(401)
    await unauthenticated.body?.cancel()
    const preview = await newEnglishPage(browser)
    await preview.context().addCookies(await page.context().cookies())
    try {
      const response = await preview.goto(new URL(path, scaffold.baseUrl).href)
      expect(response?.status()).toBe(200)
      await preview.getByText('File preview', { exact: true }).waitFor()
      expect(await preview.locator('body').getAttribute('data-script-ran')).toBeNull()
    } finally {
      await preview.close()
    }
  })

  it.skipIf(MODE === 'record')('loads permitted images and shows authored text for failures', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-markdown-images'))
    await page.getByRole('treeitem').first().click()
    await page.getByRole('treeitem').nth(1).click()
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

    const workspaceImage = page.getByRole('img', { name: WORKSPACE_ALT })
    await expect.poll(() => mediaResponses.get(join(scaffold.workspaceCwd, 'valid.png'))).toBe(200)
    await expect.poll(() => workspaceImage.evaluate(element => (element as HTMLImageElement).naturalWidth, undefined, {
      timeout: 1_000,
    }))
      .toBe(1)
    const outsideImage = page.getByRole('img', { name: 'Outside workspace image' })
    await expect.poll(() => outsideImage.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1)
    for (const alt of ['Oversized image', 'Missing image']) {
      await page.getByText(alt, { exact: true }).waitFor()
      expect(await page.getByRole('img', { name: alt }).count()).toBe(0)
    }
    await page.getByText(join(scaffold.workspaceCwd, 'corrupt.png'), { exact: true }).waitFor()
    expect(mediaResponses).toEqual(new Map([
      [join(scaffold.workspaceCwd, 'valid.png'), 200],
      [join(scaffold.workspaceCwd, 'oversized.png'), 413],
      [join(scaffold.persistenceRoot, 'outside.png'), 200],
      [join(scaffold.workspaceCwd, 'missing.png'), 404],
      [join(scaffold.workspaceCwd, 'corrupt.png'), 200],
    ]))

    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  }, 60_000)
})
