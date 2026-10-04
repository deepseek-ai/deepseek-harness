/** Browser saves control the session-log field on real DeepSeek HTTP requests. */
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import yaml from 'js-yaml'
import { expect, it, onTestFinished } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, openSettings } from './support.ts'

it.skipIf(webSnapshotMode() === 'record')('persists the upload switch and omits or resumes session logs on subsequent API requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-upload-browser-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const server = await startMockLlmServer({ sequence: ['success', 'success', 'success'], successText: 'UPLOAD_SETTING_DONE' })
  onTestFinished(() => server.close())
  const key = credentialRef('DSH_UPLOAD_BROWSER_KEY')
  const overlay = join(root, 'upload.yml')
  await writeFile(overlay, JSON.stringify([
    { id: 'llm-deepseek', config: { baseURL: server.baseURL, apiKeyEnv: key } },
    { id: 'session-log-deepseek', config: { enabled: true } },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
  ]))
  const scaffold = await launchWebScaffold({ deepSeekMissingCredential: true, extraOverlayPath: overlay })
  onTestFinished(() => scaffold.close())
  await scaffold.ctx.credentials.set(key, 'upload-browser-test-key')
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const input = page.locator('[data-composer-input]').first()
  const send = async (text: string) => {
    const settled = scaffold.whenTurnSettled()
    await input.fill(text)
    await input.press('Enter')
    return settled
  }
  const setUpload = async (enabled: boolean) => {
    await openSettings(page, 'en')
    const toggle = page.getByRole('switch', { name: 'Upload Session Log when using the official model API' })
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe(String(!enabled))
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe(String(enabled))
    await expect.poll(async () => {
      const patches = yaml.load(await readFile(join(scaffold.harnessHome, 'profiles/scaffold/cordis.patch.yml'), 'utf8')) as { id: string; config?: { enabled?: boolean } }[]
      return patches.find(patch => patch.id === 'session-log-deepseek')?.config?.enabled ?? true
    }).toBe(enabled)
    await page.keyboard.press('Escape')
  }

  const sessionId = await send('upload-enabled-marker')
  expect(server.requests).toHaveLength(1)
  expect(server.requests[0]!.body).toHaveProperty('dsh_session_log')
  const first = server.requests[0]!.body as { dsh_session_log: { throughSeq: number } }
  await setUpload(false)
  await page.reload()
  await openSettings(page, 'en')
  await expect.poll(() => page.getByRole('switch', { name: 'Upload Session Log when using the official model API' }).getAttribute('aria-checked')).toBe('false')
  await page.keyboard.press('Escape')
  expect(await send('upload-disabled-marker')).toBe(sessionId)
  expect(server.requests).toHaveLength(2)
  expect(server.requests[1]!.body).not.toHaveProperty('dsh_session_log')
  await setUpload(true)
  expect(await send('upload-resumed-marker')).toBe(sessionId)
  expect(server.requests).toHaveLength(3)
  const resumed = server.requests[2]!.body as { dsh_session_log: { events: unknown[] } }
  expect(resumed).toHaveProperty('dsh_session_log.afterSeq', first.dsh_session_log.throughSeq)
  expect(JSON.stringify(resumed.dsh_session_log.events)).toContain('"upload-disabled-marker"')
  expect(server.requests.map(request => request.outcome)).toEqual(['completed', 'completed', 'completed'])
})
