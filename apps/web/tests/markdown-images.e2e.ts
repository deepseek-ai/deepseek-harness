// Real browser image loading and failure fallbacks through the shipped Web composition.
import { mkdir, open, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  SESSION_FORMAT_VERSION,
  Session,
  type SessionId,
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
import { newEnglishPage, pinBrowserClock, saveFailureShot, WEB_FIXTURE_TIME } from './support.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

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
const STACKED_GROUPS = [['Stacked page 1', 'Stacked page 2'], ['Stacked page 3', 'Stacked page 4']]
const LISTED_ALTS = ['Listed page 1', 'Listed page 2']
const QUOTED_GROUPS = [['Quoted page 1', 'Quoted page 2'], ['Quoted page 3', 'Quoted page 4']]
const QUOTE_FOLLOW_ALTS = ['Follow page 1', 'Follow page 2']
const ITEM_GROUPS = [['Item page 1', 'Item page 2'], ['Item page 3', 'Item page 4']]

/** Encode one opaque gray RGB PNG wide enough that consecutive images stack. */
function grayPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const frame = Buffer.alloc(body.length + 8)
    frame.writeUInt32BE(data.length, 0)
    body.copy(frame, 4)
    frame.writeUInt32BE(crc32(body), body.length + 4)
    return frame
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.alloc(1 + width * 3, 0xb0)
  row[0] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

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

/** Build one closed session fixture with remote and local image Markdown. */
function markdownImageFixture(remoteUrl: string, outsidePath: string): string {
  const session = Session.create(brandString<SessionId>('markdown-image-source'))
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
          '[View comparison](./valid.png)',
          '',
          '![Space path]({{cwd}}/test workspace/测试图.png)',
          '',
          '![Encoded path]({{cwd}}/test%20workspace/测试图.png)',
          '',
          '![Encoded filename]({{cwd}}/test%20workspace/测试%23100%25.png)',
          '',
          '![Oversized image]({{cwd}}/oversized.png)',
          '',
          `![Outside workspace image](${outsidePath})`,
          '',
          '![Missing image]({{cwd}}/missing.png)',
          '',
          '![]({{cwd}}/corrupt.png)',
          '',
          ...STACKED_GROUPS.flatMap(group => [...group.map(alt => `![${alt}]({{cwd}}/page.png)`), '']),
          '- Listed step',
          '',
          ...LISTED_ALTS.map(alt => `  ![${alt}]({{cwd}}/page.png)`),
          '',
          '  | Page | State |',
          '  | --- | --- |',
          '  | Settings | Changed |',
          '',
          'Quote lead paragraph.',
          '',
          '> ### Quoted comparison',
          '>',
          ...QUOTED_GROUPS[0]!.map(alt => `> ![${alt}]({{cwd}}/page.png)`),
          '',
          'Quote middle paragraph.',
          '',
          ...QUOTED_GROUPS[1]!.map(alt => `> ![${alt}]({{cwd}}/page.png)`),
          '>',
          '> - Quoted note',
          '',
          ...QUOTE_FOLLOW_ALTS.map(alt => `![${alt}]({{cwd}}/page.png)`),
          '',
          'Item lead paragraph.',
          '',
          ...ITEM_GROUPS.flatMap(group => [`- ![${group[0]}]({{cwd}}/page.png)`, `  ![${group[1]}]({{cwd}}/page.png)`, '']),
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
    await writeFile(join(scaffold.workspaceCwd, 'local-image.png'), PNG)
    await mkdir(join(scaffold.workspaceCwd, 'test workspace'))
    await writeFile(join(scaffold.workspaceCwd, 'test workspace/测试图.png'), PNG)
    await writeFile(join(scaffold.workspaceCwd, 'test workspace/测试#100%.png'), PNG)
    await writeFile(join(scaffold.workspaceCwd, 'corrupt.png'), 'invalid image')
    await writeFile(join(scaffold.workspaceCwd, 'page.png'), grayPng(640, 120))
    const oversized = await open(join(scaffold.workspaceCwd, 'oversized.png'), 'w')
    try {
      // One byte over attachment-local's default maxImageBytes (50 MiB), which also bounds /api/file.
      await oversized.truncate(50 * 1024 * 1024 + 1)
    } finally {
      await oversized.close()
    }
    const outsidePath = join(scaffold.persistenceRoot, 'outside.png')
    await writeFile(outsidePath, PNG)
    await writeFile(join(scaffold.workspaceCwd, 'active.html'), '<p>File preview</p><script>document.body.dataset.scriptRan = "yes"</script>')
    await seedSession(scaffold, markdownImageFixture(imageOrigin.url, outsidePath), SEED_ID, undefined,
      { createdAt: WEB_FIXTURE_TIME - 60_000 })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await pinBrowserClock(page)
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
      borderRadius: '12px',
      decoding: 'async',
      loading: 'lazy',
      maxWidth: 'min(100%, 640px)',
      referrerPolicy: 'no-referrer',
    })
    await expect.poll(() => page.getByRole('img', { name: LOCAL_ALT }).evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1)
    for (const name of ['Space path', 'Encoded path', 'Encoded filename']) {
      await expect.poll(() => page.getByRole('img', { name, exact: true }).evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1)
    }
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
      await page.getByText(`Image preview unavailable · ${alt}`, { exact: true }).waitFor()
      expect(await page.getByRole('img', { name: alt }).count()).toBe(0)
    }
    await page.getByText(`Image preview unavailable · ${join(scaffold.workspaceCwd, 'corrupt.png')}`, { exact: true }).waitFor()
    // Lazy images load once scrolled into view; every page.png must have loaded before boxes are read.
    const loadedPages = async (names: readonly string[]) => {
      const images = names.map(name => page.getByRole('img', { name, exact: true }))
      for (const image of images) {
        await image.scrollIntoViewIfNeeded()
        await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(640)
      }
      return images
    }
    // Images on consecutive source lines share one paragraph; their rows keep the paragraph gap,
    // and so do two such paragraphs in a row.
    const stacked = await loadedPages(STACKED_GROUPS.flat())
    const boxes = await Promise.all(stacked.map(image => image.boundingBox()))
    for (const [index, box] of boxes.entries()) {
      if (index === 0) continue
      const above = boxes[index - 1]!
      expect(box!.y - (above.y + above.height)).toBeCloseTo(16, 0)
    }
    // The image paragraphs keep the paragraph gap to the blocks before and after them.
    const before = await stacked[0]!.evaluate(element =>
      element.closest('p')!.previousElementSibling!.getBoundingClientRect().bottom)
    const after = await stacked.at(-1)!.evaluate(element =>
      element.closest('p')!.nextElementSibling!.getBoundingClientRect().top)
    const [first, last] = [boxes[0]!, boxes.at(-1)!]
    expect(first.y - before).toBeCloseTo(16, 0)
    expect(after - (last.y + last.height)).toBeCloseTo(16, 0)
    // In a list item the rows keep 16px while the paragraph keeps the list item's 8px gap, here to a table.
    const listed = await loadedPages(LISTED_ALTS)
    const [listedFirst, listedLast] = await Promise.all(listed.map(image => image.boundingBox()))
    expect(listedLast!.y - (listedFirst!.y + listedFirst!.height)).toBeCloseTo(16, 0)
    const listedEdges = await listed[0]!.evaluate((element) => {
      const paragraph = element.closest('p')!
      return {
        before: paragraph.previousElementSibling!.getBoundingClientRect().bottom,
        after: paragraph.nextElementSibling!.getBoundingClientRect().top,
      }
    })
    expect(listedFirst!.y - listedEdges.before).toBeCloseTo(8, 0)
    expect(listedEdges.after - (listedLast!.y + listedLast!.height)).toBeCloseTo(8, 0)
    // A blockquote's bar meets an image paragraph at its edge, while a heading or list at the other
    // edge keeps its ordinary spacing.
    const [quoted1, quoted2, quoted3, quoted4, follow] = await loadedPages([...QUOTED_GROUPS.flat(), ...QUOTE_FOLLOW_ALTS])
    const [q1, q2, q3, q4] = await Promise.all([quoted1!, quoted2!, quoted3!, quoted4!].map(image => image.boundingBox()))
    expect(q2!.y - (q1!.y + q1!.height)).toBeCloseTo(16, 0)
    expect(q4!.y - (q3!.y + q3!.height)).toBeCloseTo(16, 0)
    const headed = await quoted1!.evaluate((element) => {
      const quote = element.closest('blockquote')!
      return {
        lead: quote.previousElementSibling!.getBoundingClientRect().bottom,
        heading: quote.querySelector('h3')!.getBoundingClientRect().top,
        quote: quote.getBoundingClientRect(),
      }
    })
    expect(headed.heading - headed.lead).toBeCloseTo(32, 0)
    expect(headed.quote.top).toBeCloseTo(headed.heading, 0)
    expect(headed.quote.bottom).toBeCloseTo(q2!.y + q2!.height, 0)
    const listEnded = await quoted3!.evaluate((element) => {
      const quote = element.closest('blockquote')!
      return {
        quote: quote.getBoundingClientRect(),
        list: quote.querySelector('ul')!.getBoundingClientRect().bottom,
      }
    })
    expect(listEnded.quote.top).toBeCloseTo(q3!.y, 0)
    expect(listEnded.quote.bottom).toBeCloseTo(listEnded.list, 0)
    // The list's margin collapses through the blockquote; the image paragraph after it keeps one paragraph gap.
    expect((await follow!.boundingBox())!.y - listEnded.quote.bottom).toBeCloseTo(16, 0)
    // Image paragraphs in adjacent loose list items keep the list items' 6px apart.
    const items = await loadedPages(ITEM_GROUPS.flat())
    const itemBoxes = await Promise.all(items.map(image => image.boundingBox()))
    expect(itemBoxes[1]!.y - (itemBoxes[0]!.y + itemBoxes[0]!.height)).toBeCloseTo(16, 0)
    expect(itemBoxes[2]!.y - (itemBoxes[1]!.y + itemBoxes[1]!.height)).toBeCloseTo(6, 0)
    expect(itemBoxes[3]!.y - (itemBoxes[2]!.y + itemBoxes[2]!.height)).toBeCloseTo(16, 0)
    expect(mediaResponses).toEqual(new Map([
      [join(scaffold.workspaceCwd, 'valid.png'), 200],
      [join(scaffold.workspaceCwd, 'local-image.png'), 200],
      [join(scaffold.workspaceCwd, 'test workspace/测试图.png'), 200],
      [join(scaffold.workspaceCwd, 'test workspace/测试#100%.png'), 200],
      [join(scaffold.workspaceCwd, 'oversized.png'), 413],
      [join(scaffold.persistenceRoot, 'outside.png'), 200],
      [join(scaffold.workspaceCwd, 'missing.png'), 404],
      [join(scaffold.workspaceCwd, 'corrupt.png'), 200],
      [join(scaffold.workspaceCwd, 'page.png'), 200],
    ]))

    await page.getByRole('button', { name: `View full image: ${WORKSPACE_ALT}`, exact: true }).click()
    const lightbox = page.getByRole('dialog', { name: 'Image preview', exact: true })
    await lightbox.waitFor()
    const lightboxMask = lightbox.locator(':scope > div > [aria-hidden="true"]')
    const lightboxClose = lightbox.getByRole('button', { name: 'Close image preview' })
    for (const windows of [true, false]) {
      await page.evaluate((value) => {
        document.documentElement.toggleAttribute('data-windows-titlebar', value)
        document.documentElement.style.setProperty('--dsh-windows-titlebar-height', value ? '40px' : '')
      }, windows)
      // The Windows caption stays unpainted and the close control sits below it.
      expect((await lightboxMask.boundingBox())?.y).toBe(windows ? 40 : 0)
      expect((await lightboxClose.boundingBox())?.y).toBe(windows ? 60 : 20)
    }
    await lightboxClose.click()
    await lightbox.waitFor({ state: 'detached' })
    const link = page.getByRole('button', { name: 'View comparison', exact: true })
    await link.hover()
    const hoverImage = page.getByRole('img', { name: './valid.png', exact: true })
    await hoverImage.waitFor()
    await expect.poll(() => hoverImage.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1)
    await page.keyboard.press('Escape')
    await hoverImage.waitFor({ state: 'detached' })
    await link.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await hoverImage.waitFor()
    await page.keyboard.press('Escape')
    await hoverImage.waitFor({ state: 'detached' })

    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
    const input = page.locator('[data-composer-input]').first()
    await workspaceImage.dragTo(input)
    const dragged = page.getByRole('group', { name: 'Pending attachments', exact: true }).getByRole('img')
    await dragged.waitFor({ state: 'visible' })
    expect(Buffer.from(await dragged.evaluate(async (node: HTMLImageElement) =>
      Array.from(new Uint8Array(await (await fetch(node.src)).arrayBuffer()))))).toEqual(PNG)
    expect(await input.innerText()).toBe('')
    expect(await page.getByRole('dialog', { name: 'Image preview', exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: 'Remove image valid.png', exact: true }).click()
    await link.evaluate((element) => { element.scrollIntoView({ block: 'end' }) })
    await page.mouse.move(0, 0)
    await link.hover()
    await hoverImage.waitFor()
    const linkRect = await link.boundingBox()
    if (linkRect === null) throw new Error('image link is not visible')
    const previewRect = await hoverImage.evaluate((element) => {
      const rect = element.parentElement!.parentElement!.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom }
    })
    expect(previewRect.bottom <= linkRect.y || previewRect.top >= linkRect.y + linkRect.height).toBe(true)
    const thumbnailRect = await hoverImage.boundingBox()
    if (thumbnailRect === null) throw new Error('image preview is not visible')
    expect(thumbnailRect.y + thumbnailRect.height).toBeLessThanOrEqual(previewRect.bottom)
    await page.mouse.click(linkRect.x + linkRect.width / 2, linkRect.y + linkRect.height / 2)
    await expect.poll(() => page.locator('[data-image-preview] img').evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1)
  }, 60_000)
})
