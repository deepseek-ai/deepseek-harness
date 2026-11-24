// Real-composition acceptance for paced read-aloud. The scaffold boots the shipped Web Loader tree with the read-aloud
// bundle and a cold-seeded reply of four sentences; one loopback double plays the API-key deployment's `/v1/tools/tts`.
// The real DeepSeek authentication, synthesis registry, cloud synthesizer, Remote, pacing loop and Web Audio output run
// end to end, so the requests the double receives are what a listener would be billed for. The voice preference is
// saved through the real Settings service into the scaffold profile.
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, parseSeedFixture, renderSeedFixture, seedSession, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const OVERLAY_TEMPLATE = fileURLToPath(new URL('./fixtures/read-aloud/cordis.patch.yml', import.meta.url))
const BUNDLE = fileURLToPath(new URL('../../../packages/experimental/read-aloud-bundle', import.meta.url))
// Borrowed read-only: this scenario needs any settled user and assistant pair, not a new recording.
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const READING_EXPECTED = fileURLToPath(new URL('./expected/read-aloud/reading.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const KEY = 'sk-read-aloud-e2e'
const KEY_REFERENCE = 'DSH_READ_ALOUD_E2E_KEY'

/** Four sentences of about six seconds each: with a five-second target every sentence is one segment. */
const SENTENCES = [
  'Reading aloud sends a reply to speech synthesis one short segment at a time instead of all at once.',
  'The following segment is requested only when the audio that already arrived has nearly been played.',
  'Stopping in the middle therefore leaves every later segment unsent, and nothing is billed for them.',
  'This closing sentence is never synthesized when the listener stops the reading during the second one.',
]
const REPLY = `${SENTENCES.join('\n\n')}\n\n\`\`\`sh\necho "code is not read aloud"\n\`\`\``

/** Replace the text of the borrowed recording's final assistant message, in its content and in its stream. */
function replyFixture(raw: string): string {
  const decoded = parseSeedFixture(raw)
  const last = decoded.events.findLast(event => event.type === 'assistant/message')
  const events = decoded.events.map((event) => {
    if (event !== last || event.type !== 'assistant/message') return event
    const index = event.data.message.content.findIndex(block => block.type === 'text')
    if (index < 0) throw new Error('borrowed final assistant message has no text block')
    let delta = false
    const text = { type: 'text' as const, text: REPLY }
    return { ...event, data: {
      ...event.data,
      message: { ...event.data.message, content: event.data.message.content.map((block, at) => at === index ? text : block) },
      stream: event.data.stream.flatMap((record) => {
        if (record.type !== 'chunk' || !('index' in record.chunk) || record.chunk.index !== index) return [record]
        if (record.chunk.type === 'block-end') return [{ ...record, chunk: { ...record.chunk, block: text } }]
        if (record.chunk.type !== 'text-delta') return [record]
        if (delta) return []
        delta = true
        return [{ ...record, chunk: { ...record.chunk, text: REPLY } }]
      }),
    } }
  })
  return renderSeedFixture(decoded.headerLine, events)
}

/** One synthesis request as the double received it. */
interface SynthesisRequest {
  readonly at: number
  readonly authorization: string | undefined
  readonly body: { text: string; voice_id: string; format: string; filter_markdown: boolean }
}

/** Loopback synthesis double: every request is answered with silence as long as its text reads; `failNext` answers 503 once. */
async function synthesisDouble() {
  const requests: SynthesisRequest[] = []
  const control = { failNext: false }
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/tools/tts') { res.writeHead(404).end(); return }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as SynthesisRequest['body']
      requests.push({ at: performance.now(), authorization: req.headers.authorization, body })
      if (control.failNext) {
        control.failNext = false
        res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'busy' } }))
        return
      }
      // 70 ms per letter of 24 kHz 16-bit mono PCM, the estimate the Host segments by.
      const samples = Math.round(body.text.replace(/[^A-Za-z]/g, '').length * 0.07 * 24_000)
      res.writeHead(200, { 'content-type': 'audio/pcm' }).end(Buffer.alloc(samples * 2))
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('synthesis double: missing listener address')
  return {
    origin: `http://127.0.0.1:${address.port}`, requests, control,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) }),
  }
}

describe.skipIf(MODE === 'record')('web e2e: paced read-aloud of a settled reply', () => {
  let root: string | undefined
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let services: Awaited<ReturnType<typeof synthesisDouble>>
  const previousKey = process.env[KEY_REFERENCE]

  beforeAll(async () => {
    services = await synthesisDouble()
    process.env[KEY_REFERENCE] = KEY
    root = await mkdtemp(join(tmpdir(), 'dsh-web-read-aloud-'))
    const overlay = join(root, 'read-aloud.overlay.yml')
    await writeFile(overlay, (await readFile(OVERLAY_TEMPLATE, 'utf8')).replaceAll('{{origin}}', services.origin))
    scaffold = await launchWebScaffold({
      profile: { packages: [{ dir: BUNDLE, enabled: true }] }, extraOverlayPath: overlay, deepSeekMissingCredential: true,
    })
    await seedSession(scaffold, replyFixture(await readFile(SEED, 'utf8')), 'read-aloud-web-e2e')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await services?.close()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    if (previousKey === undefined) Reflect.deleteProperty(process.env, KEY_REFERENCE)
    else process.env[KEY_REFERENCE] = previousKey
  })

  it('synthesizes one segment per request as playback advances, stops on a second click, and reports a failed request', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-read-aloud'))
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await expect.poll(() => page.getByText(SENTENCES[0]!, { exact: true }).count(), { timeout: 15_000 }).toBe(1)

    // The control appears once the Host reports a usable credential; nothing was synthesized to show it.
    const read = page.getByRole('button', { name: 'Read aloud', exact: true })
    await read.waitFor({ timeout: 15_000 })
    expect(services.requests).toHaveLength(0)
    await read.click()
    await expect.poll(() => services.requests.length, { timeout: 15_000 }).toBe(1)
    expect(services.requests[0]).toMatchObject({
      authorization: `Bearer ${KEY}`,
      body: { text: SENTENCES[0], voice_id: 'stella', format: 'pcm', filter_markdown: false },
    })
    const stop = page.getByRole('button', { name: 'Stop reading', exact: true })
    await stop.waitFor({ timeout: 10_000 })
    await expect.poll(() => stop.getAttribute('data-read-aloud'), { timeout: 10_000 }).toBe('playing')
    await compareOrRefreshGolden(READING_EXPECTED, await captureStableAria(page, '[data-turn-tail]', scaffold.workspaceCwd), MODE)

    // An earlier reply shows its action row only on hover or focus. This transcript has one reply, so its row is put in
    // that mode to check what a reading relies on: an action in progress keeps the row visible by itself.
    const tail = page.locator('[data-turn-tail]')
    const rowOpacity = (): Promise<string> => tail.locator('[data-clock="end"]').evaluate(element => getComputedStyle(element).opacity)
    const leaveRow = async (): Promise<void> => {
      await page.mouse.move(5, 5)
      await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
    }
    await tail.evaluate((element) => { element.setAttribute('data-actions-reveal', 'hover') })
    await leaveRow()
    await expect.poll(rowOpacity, { timeout: 5000 }).toBe('1')

    // The second sentence is requested only after playback has consumed half of the first: about three seconds in.
    await expect.poll(() => services.requests.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2)
    expect(services.requests[1]!.body.text).toBe(SENTENCES[1])
    expect(services.requests[1]!.at - services.requests[0]!.at).toBeGreaterThan(2000)

    // Stopping leaves the rest of the reply unsent. A slow host may have reached the third sentence by now, never the last.
    await stop.click()
    await read.waitFor({ timeout: 10_000 })
    const sent = services.requests.length
    expect(sent).toBeLessThan(SENTENCES.length)
    expect(services.requests.map(request => request.body.text)).toEqual(SENTENCES.slice(0, sent))
    await leaveRow()
    await expect.poll(rowOpacity, { timeout: 5000 }).toBe('0')
    await tail.evaluate((element) => { element.setAttribute('data-actions-reveal', 'always') })

    // A failed request ends the reading with a notice; the control returns and continues at that segment.
    services.control.failNext = true
    await read.click()
    const busy = page.getByRole('alert').filter({ hasText: 'Too many speech synthesis requests' })
    await expect.poll(() => busy.count(), { timeout: 15_000 }).toBe(1)
    await read.waitFor({ timeout: 10_000 })
    await read.click()
    await expect.poll(() => services.requests.length, { timeout: 15_000 }).toBe(sent + 2)
    expect(services.requests.slice(sent).map(request => request.body.text)).toEqual([SENTENCES[0], SENTENCES[0]])
    await page.getByRole('button', { name: 'Stop reading', exact: true }).click()
    await read.waitFor({ timeout: 10_000 })
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)

  it('states how reading is billed and links the speech synthesis guide in the bundle details', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-read-aloud-details'))
    await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    const card = page.locator('[data-plugin-package="@deepseek-ai/dsh-read-aloud-bundle"]')
    await card.getByRole('button').first().click()
    const guide = page.getByRole('link', { name: 'Speech synthesis guide', exact: true })
    await guide.waitFor({ timeout: 15_000 })
    expect(await guide.getAttribute('href')).toBe('https://api-docs.deepseek.com/guides/tts')
    const billing = 'Reading aloud uses DeepSeek cloud speech synthesis, billed per submitted character to your DeepSeek account or API '
      + 'key. A reply is submitted one segment at a time, and stopping a reading submits no further segments.'
    expect(await page.getByText(billing, { exact: true }).count()).toBe(1)
    // A credential is configured, so the details carry no sign-in prompt.
    expect(await page.getByRole('button', { name: 'Sign in to DeepSeek', exact: true }).count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('plays a sample of the saved voice, saves another voice on the Host, and reads the reply in it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-read-aloud-voice'))
    // The bundle details of the previous case are still open.
    const voice = page.getByRole('combobox', { name: 'Voice', exact: true })
    await voice.waitFor({ timeout: 15_000 })
    expect(await voice.inputValue()).toBe('stella')
    expect(await voice.locator('option').allInnerTexts()).toEqual(['Stella (female)', 'Tide (male)'])
    const before = services.requests.length
    const listen = page.getByRole('button', { name: 'Listen', exact: true })
    await listen.click()
    await expect.poll(() => services.requests.length, { timeout: 15_000 }).toBe(before + 1)
    // The sentence is the Host's own; the page sent only the voice and its language.
    expect(services.requests[before]!.body)
      .toEqual({ text: 'Hello, this is how read aloud sounds.', voice_id: 'stella', format: 'pcm', filter_markdown: false })
    const stop = page.getByRole('button', { name: 'Stop', exact: true })
    await stop.waitFor({ timeout: 10_000 })
    await expect.poll(() => stop.getAttribute('data-read-aloud'), { timeout: 10_000 }).toBe('playing')
    // The sample ends by itself once its two seconds of audio played out.
    await listen.waitFor({ timeout: 15_000 })

    // The field shows what the Host holds, so the new value appears only after the Host saved and reported it.
    await voice.selectOption('tide')
    await expect.poll(() => voice.inputValue(), { timeout: 15_000 }).toBe('tide')
    await expect.poll(() => voice.isDisabled(), { timeout: 10_000 }).toBe(false)
    expect(await page.getByRole('alert').count()).toBe(0)
    await listen.click()
    await expect.poll(() => services.requests.length, { timeout: 15_000 }).toBe(before + 2)
    expect(services.requests[before + 1]!.body.voice_id).toBe('tide')

    // Leaving the details stops the sample; a reading started afterwards uses the saved voice.
    await page.locator('[role="treeitem"]').nth(1).click()
    const read = page.getByRole('button', { name: 'Read aloud', exact: true })
    await read.waitFor({ timeout: 15_000 })
    await read.click()
    await expect.poll(() => services.requests.length, { timeout: 15_000 }).toBe(before + 3)
    expect(services.requests[before + 2]!.body).toMatchObject({ text: SENTENCES[0], voice_id: 'tide' })
    await page.getByRole('button', { name: 'Stop reading', exact: true }).click()
    await read.waitFor({ timeout: 10_000 })
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)
})
