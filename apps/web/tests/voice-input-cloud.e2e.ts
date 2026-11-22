// Real-composition acceptance for cloud dictation. The scaffold boots the shipped Web Loader tree with the voice
// bundle; one loopback double plays the DeepSeek Platform for sign-in and the account deployment's `/v1/tools/asr`,
// so the real account service, DeepSeek authentication, speech service, cloud recognizer, Remote and browser UI run
// end to end.
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, saveFailureShot } from './support.ts'

const OVERLAY_TEMPLATE = fileURLToPath(new URL('./fixtures/voice-input-cloud/cordis.patch.yml', import.meta.url))
const BUNDLE = fileURLToPath(new URL('../../../packages/experimental/voice-input-bundle', import.meta.url))
const SIGN_IN_EXPECTED = fileURLToPath(new URL('./expected/voice-input-cloud/sign-in.expected.md', import.meta.url))
const RECORDING_EXPECTED = fileURLToPath(new URL('./expected/voice-input-cloud/recording.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const TOKEN = 'dsh_web_cloud_dictation_test'
const CODE = 'cloud-dictation-code'
const TEXT = 'Summarize the latest pull request'

/** One recognition request as the double received it. */
interface RecognitionRequest {
  readonly token: string | undefined
  readonly authorization: string | undefined
  readonly fields: readonly string[]
  readonly header: string
  readonly bytes: number
}

/** Loopback Platform and recognition double; `rejectNext` makes the next recognition reject the account token. */
async function mockServices() {
  const recognitions: RecognitionRequest[] = []
  const control = { rejectNext: false }
  let state: string | undefined
  let redirectUri: string | undefined
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks)
        const reply = (payload: unknown, code = 0): void => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ code, msg: '', data: code === 0 ? { biz_code: 0, biz_msg: '', biz_data: payload } : null }))
        }
        if (url.pathname === '/dsh/authorize') {
          const callback = new URL(redirectUri ?? '/')
          callback.searchParams.set('code', CODE)
          callback.searchParams.set('state', state ?? '')
          res.writeHead(302, { location: callback.href }).end()
          return
        }
        if (url.pathname === '/dsh/authorized') { res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Authorized</title>'); return }
        if (req.method === 'POST' && url.pathname === '/auth-api/v0/dsh/auth_init') {
          const payload = JSON.parse(body.toString('utf8')) as Record<string, unknown>
          state = String(payload.state)
          redirectUri = String(payload.redirect_uri)
          reply({ authorize_url: `${origin}/dsh/authorize?authorize_id=cloud`, authorize_id: 'cloud', expires_in: 300 })
          return
        }
        if (req.method === 'POST' && url.pathname === '/auth-api/v0/dsh/auth_exchange') {
          reply({ token: TOKEN, authorized_url: `${origin}/dsh/authorized` })
          return
        }
        if (req.method === 'POST' && url.pathname === '/v1/tools/asr') {
          const form = await new Response(body, { headers: { 'content-type': req.headers['content-type'] ?? '' } }).formData()
          const file = form.get('file')
          const audio = file instanceof File ? Buffer.from(await file.arrayBuffer()) : Buffer.alloc(0)
          const token = req.headers['x-dsh-auth-token']
          recognitions.push({ token: typeof token === 'string' ? token : undefined, authorization: req.headers.authorization,
            fields: [...form.keys()], header: audio.toString('ascii', 0, 4), bytes: audio.length })
          res.writeHead(control.rejectNext ? 401 : 200, { 'content-type': 'application/json' })
          if (control.rejectNext) {
            control.rejectNext = false
            res.end(JSON.stringify({ error: { message: 'Authentication Fails (invalid dsh token)', type: 'authentication_error' } }))
          } else res.end(JSON.stringify({ request_id: 'cloud', text: TEXT, duration_ms: 300 }))
          return
        }
        if (req.headers['x-dsh-auth-token'] !== TOKEN) { res.writeHead(401).end(); return }
        if (url.pathname === '/auth-api/v0/users/current') { reply({ id: 'cloud-user', email: '', id_profile: { name: 'Cloud User' } }); return }
        if (url.pathname === '/api/v0/users/get_user_summary') { reply({ normal_wallets: [{ currency: 'CNY', balance: '1.00' }], bonus_wallets: [] }); return }
        if (url.pathname === '/api/v0/users/notifications/list') { reply({ notifications: [], next_poll_after: 600 }); return }
        res.writeHead(404).end()
      })()
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('cloud dictation: missing mock listener')
  const origin = `http://127.0.0.1:${String(address.port)}`
  return {
    origin, recognitions, control,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }),
  }
}

describe.skipIf(MODE === 'record')('web e2e: cloud dictation after DeepSeek sign-in', () => {
  let root: string | undefined
  let scaffold: WebScaffold
  let browser: Browser
  let services: Awaited<ReturnType<typeof mockServices>>
  beforeAll(async () => {
    services = await mockServices()
    root = await mkdtemp(join(tmpdir(), 'dsh-web-voice-cloud-'))
    const overlay = join(root, 'voice-cloud.overlay.yml')
    await writeFile(overlay, (await readFile(OVERLAY_TEMPLATE, 'utf8')).replaceAll('{{origin}}', services.origin))
    scaffold = await launchWebScaffold({ profile: { packages: [{ dir: BUNDLE, enabled: true }] }, extraOverlayPath: overlay })
    browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
  })
  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await services?.close()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })

  it('asks for sign-in, dictates through the account token, and asks again after the service rejects it', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })
    onTestFinished(() => context.close())
    const page = await context.newPage()
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-voice-input-cloud'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const input = page.locator('[data-composer-input]')

    await page.getByRole('button', { name: 'Open voice input setup', exact: true }).click()
    const prompt = page.getByRole('dialog', { name: 'Cloud recognition requires a DeepSeek account or API key', exact: true })
    await prompt.waitFor()
    await compareOrRefreshGolden(SIGN_IN_EXPECTED, await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), MODE)
    const tab = context.waitForEvent('page')
    await prompt.getByRole('button', { name: 'Sign in to DeepSeek', exact: true }).click()
    const authorization = await tab
    await authorization.waitForURL(url => url.pathname === '/dsh/authorized', { timeout: 30_000 })
    await page.bringToFront()
    expect(await prompt.count()).toBe(0)

    const mic = page.getByRole('button', { name: 'Start recording', exact: true })
    await mic.waitFor({ timeout: 30_000 })
    await mic.hover()
    await page.getByRole('tooltip', { name: 'Dictate · cloud recognition', exact: true }).waitFor()
    await mic.click()
    const stop = page.getByRole('button', { name: 'Stop and transcribe', exact: true })
    await stop.waitFor()
    await compareOrRefreshGolden(RECORDING_EXPECTED, await captureStableAria(page, '[data-composer-card]', scaffold.workspaceCwd), MODE)
    // Controlled fake microphone audio occupies this recording interval; it is not a readiness wait.
    await page.waitForTimeout(300)
    await stop.click()
    await expect.poll(() => input.innerText(), { timeout: 30_000 }).toBe(TEXT)
    expect(services.recognitions).toHaveLength(1)
    const [first] = services.recognitions
    // The account sign-in authenticates the request, and the recording travels unchanged as the only form field.
    expect(first).toMatchObject({ token: TOKEN, authorization: undefined, fields: ['file'], header: 'RIFF' })
    expect(first!.bytes).toBeGreaterThan(44)

    services.control.rejectNext = true
    await mic.click()
    await stop.waitFor()
    await page.waitForTimeout(300)
    await stop.click()
    await page.getByText('Your DeepSeek sign-in has expired. Sign in again.', { exact: true }).waitFor({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Sign in to DeepSeek', exact: true }).waitFor()
    expect(services.recognitions).toHaveLength(2)
    expect(await input.innerText()).toBe(TEXT)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('button', { name: 'Open voice input setup', exact: true }).waitFor({ timeout: 30_000 })
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)
})
