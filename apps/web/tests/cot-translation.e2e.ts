/** Durable reasoning translation through a real optional profile and recorded model Session. */
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginRecordOf, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { chromium, type Browser } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, readPersistedEvents, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import {
  connectFreshWorkspaceZh, expandOwningTurnProcess, PLUGIN_TOGGLE_SETTLE_MS, saveFailureShot, ZH_BROWSER_LOCALE,
} from './support.ts'

const BUNDLE_NAME = '@deepseek-ai/dsh-experimental-cot-translation-bundle'
const BUNDLE = fileURLToPath(new URL('../../../packages/experimental/cot-translation-bundle', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/lifecycle-chrome/session.v4.jsonl', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/cot-translation', import.meta.url))
const MODE = webSnapshotMode()
const ORIGINAL = 'The user wants me to reply with a single word. Let me comply.'
const GOOGLE_TRANSLATION = '用户让我只回复一个词。我会照做。'
const BING_TRANSLATION = '用户要求我回复一个单词。'
const JAPANESE_TRANSLATION = 'ユーザーは単語一つでの返答を求めています。'
const GERMAN_TRANSLATION = 'Der Nutzer möchte eine Antwort mit einem einzigen Wort.'

/** Translation records are the only additions permitted beside the recorded conversation. */
function isTranslationRecord(event: SessionEvent): boolean {
  const type = pluginRecordOf(event)?.type
  return type === 'plugin:translator/request' || type === 'plugin:translator/result'
}

interface TranslationCall {
  provider: 'google' | 'bing'
  text: string
  target: string
  hasAuthorization: boolean
  hasCookie: boolean
}

interface PendingTranslation {
  response: ServerResponse
  closed: boolean
  settled: Promise<undefined>
}

/** Read an external provider's request body without intercepting Host or model traffic. */
async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

it.skipIf(MODE === 'record')('persists Bing reasoning translation across reopen and browser reload, changes provider and language, retains originals on failure and cancels uncached requests', async () => {
  const resources: { scaffold?: WebScaffold; browser?: Browser } = {}
  const root = await mkdtemp(join(tmpdir(), 'dsh-cot-translation-'))
  const calls: TranslationCall[] = []
  const fixtureErrors: unknown[] = []
  const requests: Promise<void>[] = []
  const heldResponses = new Set<ServerResponse>()
  const pendingTranslation = Promise.withResolvers<PendingTranslation | undefined>()
  let fail = false
  let holdNextResponse = false
  async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://translation.test')
    const provider = url.pathname === '/google' ? 'google' : 'bing'
    let text: string
    let target: string
    if (provider === 'google') {
      expect(request.method).toBe('POST')
      expect(request.headers['content-type']).toMatch(/^application\/x-www-form-urlencoded(?:;|$)/)
      expect(url.searchParams.has('q')).toBe(false)
      const body = new URLSearchParams(await requestBody(request))
      expect(body.get('client')).toBe('gtx')
      expect(body.get('sl')).toBe('auto')
      expect(body.get('dt')).toBe('t')
      text = body.get('q') ?? ''
      target = body.get('tl') ?? ''
    } else {
      expect(url.pathname).toBe('/bing')
      expect(request.method).toBe('POST')
      expect(url.searchParams.get('isEnterpriseClient')).toBe('false')
      expect(url.searchParams.has('from')).toBe(false)
      const body: unknown = JSON.parse(await requestBody(request))
      if (!Array.isArray(body) || body.length !== 1 || typeof body[0] !== 'string') {
        throw new Error('Bing must receive exactly one text string')
      }
      text = body[0]
      target = url.searchParams.get('to') ?? ''
    }
    calls.push({ provider, text, target,
      hasAuthorization: request.headers.authorization !== undefined, hasCookie: request.headers.cookie !== undefined })
    if (holdNextResponse) {
      holdNextResponse = false
      const closed = Promise.withResolvers<undefined>()
      const pending: PendingTranslation = { response, closed: false, settled: closed.promise }
      heldResponses.add(response)
      response.once('close', () => {
        pending.closed = true
        heldResponses.delete(response)
        closed.resolve(undefined)
      })
      pendingTranslation.resolve(pending)
      await pending.settled
      return
    }
    if (fail) { response.writeHead(503); response.end(); return }
    const translated = target === 'ja' ? JAPANESE_TRANSLATION : target === 'de' ? GERMAN_TRANSLATION
      : provider === 'google' ? GOOGLE_TRANSLATION : BING_TRANSLATION
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(provider === 'google'
      ? [[[translated, text, null, null]], null, 'en']
      : [{ translations: [{ text: translated, to: target }] }]))
  }
  const server = createServer((request, response) => {
    requests.push(respond(request, response).catch((error: unknown) => {
      fixtureErrors.push(error)
      if (!response.destroyed) { response.writeHead(500); response.end() }
    }))
  })
  onTestFinished(async () => {
    const failures: unknown[] = []
    pendingTranslation.resolve(undefined)
    for (const response of heldResponses) response.destroy()
    await resources.browser?.close().catch((error: unknown) => failures.push(error))
    await resources.scaffold?.close().catch((error: unknown) => failures.push(error))
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
    })
    server.closeAllConnections()
    await closed.catch((error: unknown) => failures.push(error))
    await Promise.all(requests).catch((error: unknown) => failures.push(error))
    await rm(root, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    if (failures.length > 0) throw new AggregateError(failures, 'CoT translation teardown failed')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected an allocated loopback listener')
  const origin = `http://127.0.0.1:${address.port}`
  const overlay = join(root, 'translator.patch.yml')
  await writeFile(overlay, `- id: translator\n  config: ${JSON.stringify({
    googleEndpoint: `${origin}/google`, bingEndpoint: `${origin}/bing`,
    // The provider deadline must exceed the cancellation observation's 10-second bound.
    timeoutMs: 120_000,
  })}\n`)
  const scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: BUNDLE }] },
    extraOverlayPath: overlay,
    replayFixture: FIXTURE,
    // Translation records are asserted separately from the unchanged borrowed conversation.
    compareReplaySession: false,
  })
  resources.scaffold = scaffold
  const browser = await chromium.launch()
  resources.browser = browser
  const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE, timezoneId: 'Asia/Shanghai' })
  const page = await context.newPage()
  const settings = await context.newPage()
  const consoles = [watchConsole(page), watchConsole(settings)]
  onTestFailed(async () => {
    await saveFailureShot(page, 'web-e2e-cot-translation')
    await saveFailureShot(settings, 'web-e2e-cot-translation-settings')
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  const prompts = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
  expect(prompts).toHaveLength(1)
  const prompt = prompts[0]
  if (prompt === undefined) throw new Error('Recorded translation scenario requires a user prompt')
  const settled = scaffold.whenTurnSettled()
  const composer = page.locator('[data-composer-input]').first()
  await composer.fill(prompt)
  await composer.press('Enter')
  const sessionId = await settled
  await page.getByText('LIGHTHOUSE', { exact: true }).waitFor()
  const reasoning = page.locator('[data-variant="think"]').first()
  await reasoning.waitFor({ state: 'attached' })
  await expandOwningTurnProcess(page, reasoning)
  await reasoning.locator('[data-disclosure-row]').first().click()
  await reasoning.getByText(ORIGINAL, { exact: true }).waitFor()
  expect(await reasoning.locator('[data-cot-translation]').count()).toBe(0)
  expect(calls).toEqual([])
  await reasoning.locator('[data-disclosure-row]').first().click()
  const recordedEvents = await readPersistedEvents(scaffold, sessionId)
  const session = scaffold.ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error('Recorded reasoning requires its existing Session')
  const recordedHeader = (await scaffold.ctx.sessionPersistence.stat(sessionId))?.header
  if (recordedHeader === undefined) throw new Error('Recorded reasoning requires its durable Session header')
  const recordedModelHistory = session.deriveMessages(), recordedRequestHeader = session.requestHeader()

  await settings.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await settings.getByRole('button', { name: '插件', exact: true }).click()
  const panel = settings.locator('[data-plugin-panel]')
  await panel.getByRole('button', { name: '更多', exact: true }).click()
  const card = panel.locator(`[data-plugin-package="${BUNDLE_NAME}"]`)
  const toggle = card.getByRole('switch')
  await toggle.waitFor()
  expect(await toggle.getAttribute('aria-checked')).toBe('false')
  await toggle.click()
  await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toBe('true')
  await card.getByRole('button').first().click()
  const provider = panel.getByLabel('翻译服务', { exact: true })
  const target = panel.getByLabel('目标语言', { exact: true })
  await provider.waitFor()
  expect(await provider.inputValue()).toBe('bing')
  expect(await target.inputValue()).toBe('auto')
  await panel.getByText('展开的思考内容会发送给所选翻译服务，可能包含私有代码或对话细节。', { exact: true }).waitFor()
  await compareOrRefreshGolden(join(EXPECTED, 'preferences.expected.md'),
    await captureStableAria(settings, '[data-plugin-panel]', scaffold.workspaceCwd, {
      replacements: [[BUNDLE, '{{bundle}}']],
    }), MODE)
  expect(calls).toEqual([])
  await reasoning.locator('[data-disclosure-row]').first().click()
  const body = reasoning.locator('[data-cot-translation="true"]')
  await body.getByText(BING_TRANSLATION, { exact: true }).waitFor()
  await expect.poll(() => body.getAttribute('data-translation-state')).toBe('ready')
  expect(calls).toEqual([{ provider: 'bing', text: ORIGINAL, target: 'zh-Hans', hasAuthorization: false, hasCookie: false }])
  await compareOrRefreshGolden(join(EXPECTED, 'bing.expected.md'),
    await captureStableAria(page, '[data-variant="think"]', scaffold.workspaceCwd), MODE)
  const markdown = body.locator('[data-markdown-variant="compact"]')
  const typography = () => markdown.evaluate((element) => {
    const style = getComputedStyle(element)
    return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight, style.color, style.padding, style.margin]
  })
  const translatedTypography = await typography()
  const originalAction = body.getByRole('button', { name: '查看原文', exact: true })
  await composer.focus()
  await page.mouse.move(0, 0)
  await expect.poll(() => originalAction.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
  expect(await originalAction.evaluate(element => element.closest('[data-disclosure-header]') === null)).toBe(true)
  await originalAction.focus()
  await expect.poll(() => originalAction.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
  await originalAction.press('Enter')
  await body.getByText(ORIGINAL, { exact: true }).waitFor()
  expect(await body.getAttribute('data-translation-view')).toBe('original')
  expect(await typography()).toEqual(translatedTypography)
  await page.mouse.move(0, 0)
  const translationAction = body.getByRole('button', { name: '查看译文', exact: true })
  const titleBox = await reasoning.getByRole('button', { name: '思考', exact: true }).boundingBox()
  const actionBox = await translationAction.boundingBox()
  if (titleBox === null || actionBox === null) throw new Error('Reasoning title and translation action must be visible')
  expect(actionBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height)
  expect(await translationAction.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
  await translationAction.click()
  await composer.focus()
  await reasoning.hover()
  await expect.poll(() => originalAction.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
  await body.getByText(BING_TRANSLATION, { exact: true }).waitFor()
  expect(calls).toHaveLength(1)
  const savedBing = await readPersistedEvents(scaffold, sessionId)
  expect(savedBing.filter(event => !isTranslationRecord(event))).toEqual(recordedEvents)
  const bingRecords = savedBing.filter(isTranslationRecord)
  expect(bingRecords).toHaveLength(2)
  expect(bingRecords[0]).toMatchObject({ type: 'plugin:translator/request', ignorable: true,
    data: { provider: 'bing', text: ORIGINAL, sourceLanguage: 'auto', targetLanguage: 'zh' } })
  const bingRequest = pluginRecordOf(bingRecords[0]!)?.data
  if (typeof bingRequest !== 'object' || bingRequest === null || !('recipe' in bingRequest)) {
    throw new Error('Translation request lacks its recipe identity')
  }
  expect(typeof bingRequest.recipe).toBe('string')
  expect(bingRecords[1]).toMatchObject({ type: 'plugin:translator/result', ignorable: true,
    data: { requestSeq: bingRecords[0]?.seq, text: BING_TRANSLATION } })

  await reasoning.locator('[data-disclosure-row]').first().click()
  await body.waitFor({ state: 'detached' })
  await reasoning.locator('[data-disclosure-row]').first().click()
  await body.getByText(BING_TRANSLATION, { exact: true }).waitFor()
  await expect.poll(() => body.getAttribute('data-translation-state')).toBe('ready')
  expect(calls).toHaveLength(1)
  expect(await readPersistedEvents(scaffold, sessionId)).toEqual(savedBing)
  const warningStart = consoles[0]!.warnings.length
  await page.reload({ waitUntil: 'load' })
  await page.getByText('LIGHTHOUSE', { exact: true }).waitFor()
  await reasoning.waitFor({ state: 'attached' })
  await expandOwningTurnProcess(page, reasoning)
  const disclosure = reasoning.locator('[data-disclosure-row]').first()
  if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click()
  await body.getByText(BING_TRANSLATION, { exact: true }).waitFor()
  await expect.poll(() => body.getAttribute('data-translation-state')).toBe('ready')
  acknowledgeReloadConnectionLoss(consoles[0]!, warningStart)
  expect(calls).toHaveLength(1)
  expect(await readPersistedEvents(scaffold, sessionId)).toEqual(savedBing)

  await provider.selectOption('google')
  await target.fill('zh')
  expect(calls).toHaveLength(1)
  const save = panel.getByRole('button', { name: '保存', exact: true })
  await save.click()
  await expect.poll(() => save.isDisabled()).toBe(true)
  await body.getByText(GOOGLE_TRANSLATION, { exact: true }).waitFor()
  expect(calls[1]).toEqual({ provider: 'google', text: ORIGINAL, target: 'zh-CN', hasAuthorization: false, hasCookie: false })
  expect(calls).toHaveLength(2)

  fail = true
  await target.fill('ja')
  await save.click()
  await expect.poll(() => save.isDisabled()).toBe(true)
  await expect.poll(() => body.getAttribute('data-translation-state')).toBe('failed')
  await body.getByText('翻译暂不可用，已显示原文', { exact: true }).waitFor()
  await body.getByText(ORIGINAL, { exact: true }).waitFor()
  expect(await body.getAttribute('data-translation-view')).toBe('original')
  expect(calls[2]).toEqual({ provider: 'google', text: ORIGINAL, target: 'ja', hasAuthorization: false, hasCookie: false })
  expect(calls).toHaveLength(3)
  await compareOrRefreshGolden(join(EXPECTED, 'failure.expected.md'),
    await captureStableAria(page, '[data-variant="think"]', scaffold.workspaceCwd), MODE)
  fail = false
  await body.getByRole('button', { name: '重试', exact: true }).click()
  await body.getByText(JAPANESE_TRANSLATION, { exact: true }).waitFor()
  await expect.poll(() => body.getAttribute('data-translation-state')).toBe('ready')
  expect(calls).toHaveLength(4)
  expect(calls[3]).toEqual({ provider: 'google', text: ORIGINAL, target: 'ja', hasAuthorization: false, hasCookie: false })

  await reasoning.locator('[data-disclosure-row]').first().click()
  await body.waitFor({ state: 'detached' })
  await target.fill('de')
  await save.click()
  await expect.poll(() => save.isDisabled()).toBe(true)
  holdNextResponse = true
  await reasoning.locator('[data-disclosure-row]').first().click()
  await expect.poll(() => heldResponses.size, { timeout: 10_000 }).toBe(1)
  const pending = await pendingTranslation.promise
  if (pending === undefined) throw new Error('Translation fixture ended before receiving the held request')
  await expect.poll(() => body.getAttribute('data-translation-state')).toBe('pending')
  expect(calls).toHaveLength(5)
  expect(calls[4]).toEqual({ provider: 'google', text: ORIGINAL, target: 'de', hasAuthorization: false, hasCookie: false })
  expect(pending.response.headersSent).toBe(false)
  await reasoning.locator('[data-disclosure-row]').first().click()
  await body.waitFor({ state: 'detached' })
  await expect.poll(() => pending.closed, { timeout: 10_000 }).toBe(true)
  await pending.settled
  expect(pending.response.headersSent).toBe(false)
  expect(pending.response.writableFinished).toBe(false)
  expect(await reasoning.getByText(JAPANESE_TRANSLATION, { exact: true }).count()).toBe(0)
  await reasoning.locator('[data-disclosure-row]').first().click()
  await body.getByText(GERMAN_TRANSLATION, { exact: true }).waitFor()
  await expect.poll(() => body.getAttribute('data-translation-state')).toBe('ready')
  expect(calls).toHaveLength(6)

  await panel.getByRole('button', { name: '返回 实验性插件', exact: true }).click()
  await toggle.click()
  await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toBe('false')
  await body.waitFor({ state: 'detached' })
  await reasoning.getByText(ORIGINAL, { exact: true }).waitFor()
  await reasoning.locator('[data-disclosure-row]').first().click()
  await reasoning.locator('[data-disclosure-row]').first().click()
  await reasoning.getByText(ORIGINAL, { exact: true }).waitFor()
  expect(calls).toHaveLength(6)
  const completedEvents = await readPersistedEvents(scaffold, sessionId)
  expect(completedEvents.filter(event => !isTranslationRecord(event))).toEqual(recordedEvents)
  expect((await scaffold.ctx.sessionPersistence.stat(sessionId))?.header).toEqual(recordedHeader)
  expect(session.deriveMessages()).toEqual(recordedModelHistory)
  expect(session.requestHeader()).toEqual(recordedRequestHeader)
  const translationRecords = completedEvents.filter(isTranslationRecord)
  const requestsBySeq = new Map(translationRecords.flatMap(event => pluginRecordOf(event)?.type === 'plugin:translator/request' ? [[event.seq, event] as const] : []))
  const results = translationRecords.filter(event => pluginRecordOf(event)?.type === 'plugin:translator/result')
  expect(requestsBySeq.size).toBe(6)
  expect(results).toHaveLength(4)
  expect(results.map(event => event.data)).toEqual([
    { requestSeq: translationRecords[0]?.seq, text: BING_TRANSLATION },
    { requestSeq: translationRecords[2]?.seq, text: GOOGLE_TRANSLATION },
    { requestSeq: translationRecords[5]?.seq, text: JAPANESE_TRANSLATION },
    { requestSeq: translationRecords[8]?.seq, text: GERMAN_TRANSLATION },
  ])
  for (const result of results) {
    const data = pluginRecordOf(result)?.data
    if (typeof data !== 'object' || data === null || !('requestSeq' in data) || typeof data.requestSeq !== 'number') {
      throw new Error('Translation result lacks its durable request sequence')
    }
    const request = requestsBySeq.get(SessionSeq(data.requestSeq))
    expect(request?.seq).toBeLessThan(result.seq)
  }
  const modelLog = JSON.stringify(recordedModelHistory)
  for (const translated of [GOOGLE_TRANSLATION, BING_TRANSLATION, JAPANESE_TRANSLATION, GERMAN_TRANSLATION]) {
    expect(modelLog).not.toContain(translated)
  }
  expect(fixtureErrors).toEqual([])
  for (const console of consoles) {
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
  }
  await assertFixtureInventory(EXPECTED, ['bing.expected.md', 'preferences.expected.md', 'failure.expected.md'])
})
