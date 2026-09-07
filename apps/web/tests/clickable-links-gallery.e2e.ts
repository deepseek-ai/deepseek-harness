// Web e2e gallery: every clickable link and artifact form the chat renders,
// in one settled keyless turn — the regression anchor for unifying link
// styles. One fixture turn produces:
// - prose: Markdown link, reference-style link, mailto link, inline-code URL,
//   produced-file mention, plus inert contrasts (ambiguous basename, unwritten
//   file, command code, URL-with-flags code, javascript: destination,
//   footnote superscript, remote image, fenced code block with its copy chrome)
// - artifacts: seven produced files (chips overflow into the "+N" remainder
//   and the show-in-folder affordance) with a failed write excluded
// - tool rows: write/edit/str_replace_editor/read file links, a failure row
//   without one, and — expanded — the web-search source links (one non-http
//   source stays inert) and answer link, the web-fetch URL, the read card's
//   inert path label and fold toggle, the diff card's inert path header, the
//   grep card's fold-only file headers, a failing bash card's exit status, and
//   a generic tool card's IN/OUT surfaces.
// Image thumbnails and subagent rows stay out: the first needs real attachment
// bytes (image-display.expected.e2e.ts owns that route) and the second needs a
// child session (subagent-conversation owns it).
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
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

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/clickable-links-gallery', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./expected/clickable-links-gallery/ui.expected.md', import.meta.url))
// The golden holds the show-in-folder affordance; pin the native-opener
// capability so headless Linux CI and desktop developer hosts expose the same
// UI branch (same pin as produced-files.e2e.ts, whose overlay this shares).
const OVERLAY = fileURLToPath(new URL('./produced-files.overlay.yml', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'clickable-links-gallery-web-e2e'
const DONE = 'LINK_GALLERY_DONE'

const GUIDE_URL = 'https://docs.example.test/guide'
const API_URL = 'https://docs.example.test/api'
const RELEASES_URL = 'https://docs.example.test/releases'
const MAILTO_URL = 'mailto:owner@example.test'
const SOURCE_URL = 'https://docs.example.test/links'
const INERT_SOURCE_URL = 'ftp://mirror.example.test/spec'
const FETCH_URL = 'https://docs.example.test/tokens'

/** One-part text content for a built message. */
function text(value: string): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: value }]
}

/** A settled root tool call: its call event arguments plus result content/meta. */
interface GalleryCall {
  name: string
  args: Record<string, unknown>
  result: string
  meta?: JsonValue
  isError?: true
}

/** The five successful writes; docs/press.md and src/tokens.css join via other tools. */
const WRITES = ['site/report.html', 'a/style.css', 'b/style.css', 'site/index.html', 'site/app.js']

/** The gallery turn's tool calls, in surface order. */
const CALLS: GalleryCall[] = [
  ...WRITES.map(path => ({
    name: 'write',
    args: { file_path: path, content: `content of ${path}\n` },
    result: `Created ${path}`,
  })),
  {
    name: 'edit',
    args: {
      file_path: 'src/tokens.css',
      old_string: '--inline-code: #EBEEF2;',
      new_string: '--inline-code: #F5F5F5;',
    },
    result: 'Edited src/tokens.css',
    meta: {
      diffs: [{
        path: 'src/tokens.css',
        oldText: '--inline-code: #EBEEF2;\n',
        newText: '--inline-code: #F5F5F5;\n',
      }],
    },
  },
  {
    name: 'str_replace_editor',
    args: { command: 'create', path: 'docs/press.md', file_text: '# Press kit\n' },
    result: 'Created docs/press.md',
    meta: { diffs: [{ path: 'docs/press.md', oldText: null, newText: '# Press kit\n' }] },
  },
  {
    name: 'write',
    args: { file_path: 'c/broken.css', content: 'nope\n' },
    result: 'permission denied: c/broken.css',
    isError: true,
  },
  {
    name: 'read',
    args: { file_path: 'docs/guide.md' },
    // The read card validates the model-facing envelope, not just the meta:
    // without <path>/<type>/<content> the row falls back to the generic card.
    result: [
      '<path>docs/guide.md</path>',
      '<type>file</type>',
      '<content>',
      ...Array.from({ length: 12 }, (_, index) =>
        index === 0 ? '# Link style guide' : `guide line ${String(index + 1)}`),
      '</content>',
    ].join('\n'),
    meta: {
      path: 'docs/guide.md',
      offset: 1,
      lines: Array.from({ length: 12 }, (_, index) => ({
        number: index + 1,
        text: index === 0 ? '# Link style guide' : `guide line ${String(index + 1)}`,
      })),
      totalLines: 12,
    },
  },
  {
    name: 'grep',
    args: { pattern: 'linkColor' },
    result: 'nine matches across three files',
    meta: {
      shape: 'matches',
      files: ['a/style.css', 'b/style.css', 'src/tokens.css'].map(path => ({
        path,
        matches: [3, 7, 11].map(lineNumber => ({ lineNumber, line: '  color: var(--linkColor);' })),
      })),
      truncated: false,
      total: 9,
    },
  },
  {
    name: 'glob',
    args: { pattern: '**/*.css' },
    result: 'a/style.css\nb/style.css\nsrc/tokens.css',
    meta: { shape: 'paths', paths: ['a/style.css', 'b/style.css', 'src/tokens.css'], truncated: false, total: 3 },
  },
  {
    name: 'bash',
    args: { command: 'ls site', description: 'List the built site' },
    result: 'report.html\nindex.html\napp.js\n',
  },
  {
    name: 'bash',
    args: { command: 'pnpm run lint', description: 'Run the lint gate', workdir: 'site' },
    result: 'style.css: unexpected hex literal\n[exit code: 1]',
  },
  {
    name: 'web_search',
    args: { queries: ['clickable link styles', 'produced files ui'] },
    result: 'Two sources found.',
    meta: {
      truncated: false,
      answer: `Unify links per [the guide](${GUIDE_URL}).`,
      sources: [
        { url: SOURCE_URL, title: 'Link styles reference', snippet: 'One cursor token, one focus ring.' },
        { url: INERT_SOURCE_URL, title: 'Mirror spec (non-http)', snippet: 'A non-http source renders inert.' },
      ],
    },
  },
  {
    name: 'web_fetch',
    args: { url: FETCH_URL },
    result: 'Design token reference page.',
    meta: { url: FETCH_URL, statusCode: 200, truncated: false },
  },
  {
    name: 'design_tokens_sync',
    args: { source: 'design-platform.css', dryRun: false },
    result: '{"synced":true,"tokens":12}',
  },
]

/**
 * Build the settled gallery turn: every call above plus a link-dense closing prose.
 * @param imageUrl - scaffold-hosted image the prose embeds (kept same-origin so
 *   the tripwire stays clean; the varying origin is tokenized in the golden).
 */
function galleryFixture(imageUrl: string): string {
  const session = Session.create(SessionId('clickable-links-gallery-source'))
  const eventTimeOrigin = new Date().setHours(12, 0, 0, 0)
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: text('Assemble the link gallery: write the report and styles, inspect the sources, and summarize.'),
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title: 'Clickable links gallery',
    messageSeqs: [user.seq],
    source: { kind: 'fallback' },
  })
  session.append('step/start', { turn: 1, step: 1 })
  const calls = CALLS.map((call, index) => ({
    ...call,
    callId: ToolCallId(`gallery-${String(index)}`),
    argsJson: JSON.stringify(call.args),
  }))
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: calls.map(call => ({
        type: 'tool-call' as const,
        id: call.callId,
        name: call.name,
        arguments: call.argsJson,
      })),
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
  for (const call of calls) {
    const source = session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: call.callId,
      name: call.name,
      arguments: call.argsJson,
    })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: call.callId,
        content: text(call.result),
        isError: call.isError === true,
      }),
      ...(call.meta === undefined ? {} : { meta: call.meta }),
    }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
  }
  session.append('step/end', { turn: 1, step: 1 })
  session.append('step/start', { turn: 1, step: 2 })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 2,
    message: createAssistantMessage({
      content: text([
        '## Link gallery',
        '',
        `Docs: [style guide](${GUIDE_URL}) and \`${API_URL}\`; see [the release notes][rel], `
        + `contact [the maintainer](${MAILTO_URL}), and check the fine print[^1].`,
        '',
        `Inert contrasts: \`curl ${API_URL}\`, \`javascript:alert(1)\`, and \`pnpm run build\`.`,
        '',
        'Wrote `report.html` plus two `style.css` copies; `notes.md` untouched.',
        '',
        `![Token preview](${imageUrl})`,
        '',
        '```css',
        '--inline-code: #F5F5F5;',
        '```',
        '',
        DONE,
        '',
        `[rel]: ${RELEASES_URL}`,
        '',
        '[^1]: Footnote references stay inert superscripts.',
      ].join('\n')),
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 2 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  return [
    JSON.stringify({
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: '{{sessionId}}',
      createdAt: 0,
      cwd: '{{cwd}}',
      isSeeded: false,
      delegationDepth: 0,
    }),
    ...session.snapshotEvents().map(event => JSON.stringify({
      ...event,
      time: eventTimeOrigin + event.seq * 1_000,
    })),
    '',
  ].join('\n')
}

describe('web e2e: clickable links gallery', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let imageUrl: string
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    imageUrl = new URL('/favicon.svg', scaffold.baseUrl).toString()
    await seedSession(scaffold, galleryFixture(imageUrl), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it.skipIf(MODE === 'record')('renders every clickable link and artifact form of the settled turn', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-clickable-links-gallery'))
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await expect.poll(() => page.getByText(DONE, { exact: true }).count(), { timeout: 15_000 }).toBe(1)

    // Markdown prose: plain, reference-style, and mailto links plus the
    // inline-code URL are anchors; the URL-with-flags code, the javascript:
    // destination, and plain command code stay inert.
    const markdown = page.locator('[class*="markdown"]')
    await expect.poll(() => markdown.locator(`a[href="${GUIDE_URL}"]`).count(), { timeout: 10_000 }).toBe(1)
    expect(await markdown.locator(`a[href="${RELEASES_URL}"]`).count()).toBe(1)
    expect(await markdown.locator(`a[href="${MAILTO_URL}"]`).count()).toBe(1)
    const inlineCodeLink = markdown.locator(`code a[href="${API_URL}"]`)
    expect(await inlineCodeLink.count()).toBe(1)
    expect(await inlineCodeLink.getAttribute('target')).toBe('_blank')
    expect(await page.getByText(`curl ${API_URL}`, { exact: true }).locator('a').count()).toBe(0)
    expect(await page.getByText('javascript:alert(1)', { exact: true }).locator('a').count()).toBe(0)
    expect(await markdown.locator(`img[src="${imageUrl}"]`).count()).toBe(1)

    // Produced files: one unique-basename mention links; the shared basename
    // and the unwritten file stay inert code. Seven produced paths overflow
    // the chip row; the failed write joins neither surface.
    const mentions = markdown.locator('code button')
    expect(await mentions.count()).toBe(1)
    expect(await mentions.first().getAttribute('title')).toBe('site/report.html')
    expect(await page.getByText('Produced', { exact: true }).count()).toBe(1)
    expect(await page.locator('[class*="centerCol"] button[aria-label^="Open "]').count()).toBeGreaterThanOrEqual(5)
    expect(await page.locator('button[aria-label="Open c/broken.css"]').count()).toBe(0)

    // Tool rows: five writes, the edit, and the read carry the dotted file
    // link; the failed write row does not, and neither does str_replace_editor
    // — TOOL_VARIANTS has no entry for it, so it falls to the generic row with
    // no openable path even though its create still joins the produced chips.
    expect(await page.locator('button[class*="fileLink"]').count()).toBe(7)

    // Expanded cards. The turn-process group collapses a multi-call turn, so
    // it opens first. Rows expand via a right-edge click: the row center can
    // land on the nested fileLink button, which would hand the path to the
    // Host's opener.
    await page.getByRole('button', { name: `${String(CALLS.length)} tool calls` }).click()
    for (const row of [
      /^Search clickable link styles/,
      /^Fetch /,
      /^Read docs\/guide\.md/,
      /^Edit src\/tokens\.css/,
      /^Grep linkColor/,
      /Run the lint gate|pnpm run lint/,
    ]) {
      const toggle = page.getByRole('button', { name: row }).first()
      await toggle.waitFor({ timeout: 10_000 })
      const box = await toggle.boundingBox()
      await toggle.click(box === null ? {} : { position: { x: box.width - 8, y: box.height / 2 } })
    }
    // Both generic rows (the unclassified str_replace_editor and the unknown
    // design_tokens_sync) expand to their IN/OUT surfaces.
    const genericRows = page.getByRole('button', { name: /^Tool call/ })
    for (let index = 0; index < await genericRows.count(); index += 1) {
      const toggle = genericRows.nth(index)
      const box = await toggle.boundingBox()
      await toggle.click(box === null ? {} : { position: { x: box.width - 8, y: box.height / 2 } })
    }
    const sourceLink = page.locator(`a[href="${SOURCE_URL}"]`)
    await expect.poll(() => sourceLink.count(), { timeout: 10_000 }).toBe(1)
    expect(await page.locator('a[href^="ftp:"]').count()).toBe(0)
    expect(await page.locator(`a[href="${FETCH_URL}"]`).count()).toBe(1)
    expect(await page.locator(`a[href="${GUIDE_URL}"]`).count()).toBe(2)

    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
      .split(imageUrl).join('{{imageUrl}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])

    // The link language itself — ARIA records none of it, so pin the computed
    // styles: link-blue 500-weight text, no underline at rest, dotted underline
    // on hover, and a leading currentColor glyph. Light theme, so the link
    // alias resolves to deepseek-500.
    const LINK_BLUE = 'rgb(65, 118, 230)'
    const styleOf = async (target: ReturnType<Page['locator']>, property: string): Promise<string> =>
      target.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property)
    const guideLink = markdown.locator(`a[href="${GUIDE_URL}"]`).first()
    const chip = page.locator('button[aria-label="Open site/report.html"]').first()
    for (const [name, link] of [
      ['markdown anchor', guideLink],
      ['file mention', mentions.first()],
      ['search source', sourceLink.first()],
      ['fetch url', page.locator(`a[href="${FETCH_URL}"]`).first()],
      ['produced chip', chip],
    ] as const) {
      expect.soft(await styleOf(link, 'color'), `${name} color`).toBe(LINK_BLUE)
      expect.soft(await styleOf(link, 'font-weight'), `${name} weight`).toBe('500')
      expect.soft(await styleOf(link, 'text-decoration-line'), `${name} at rest`).toBe('none')
      expect.soft(await link.locator('svg').count(), `${name} glyph`).toBe(1)
    }
    await guideLink.hover()
    expect(await styleOf(guideLink, 'text-decoration-line')).toBe('underline')
    expect(await styleOf(guideLink, 'text-decoration-style')).toBe('dotted')
    expect(await styleOf(guideLink, 'text-underline-offset')).toBe('3px')
    await chip.hover()
    expect(await styleOf(chip, 'text-decoration-style')).toBe('dotted')
    expect(await styleOf(chip, 'background-color')).toBe('rgba(0, 0, 0, 0)')
    // The excluded grey affordance: tool-row file links keep their own color.
    expect(await styleOf(page.locator('button[class*="fileLink"]').first(), 'color')).not.toBe(LINK_BLUE)
  }, 90_000)
})
