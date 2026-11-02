/** Saved credentials and endpoints reach the assembled editor and provider requests. */
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { openSettings, ZH_BROWSER_LOCALE } from './support.ts'

it.each([false, true])('edits saved DeepSeek keys and restores environment detection (environment present: %s)', async (hasEnvironment) => {
  const scaffold = await launchWebScaffold({
    deepSeekMissingCredential: true,
    extraOverlayPath: fileURLToPath(new URL('./fixtures/credential-editor.patch.yml', import.meta.url)),
    openInAppEnvironment: createLaunchEnvironmentSnapshot([{
      source: 'process', values: hasEnvironment ? { DEEPSEEK_API_KEY: 'fixture-environment-key' } : {},
    }]),
  })
  try {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
      const ref = credentialRef('DEEPSEEK_API_KEY')
      await scaffold.ctx.credentials.set(ref, 'fixture-saved-deepseek-key')
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await openSettings(page, 'zh')
      const dialog = page.getByRole('dialog', { name: '设置' })
      await dialog.getByRole('button', { name: '模型', exact: true }).click()
      const edit = dialog.getByRole('button', { name: '编辑 DeepSeek (deepseek-official)', exact: true })
      await edit.click()
      const key = dialog.getByLabel('API 密钥', { exact: true })
      await expect.poll(() => key.inputValue()).toBe('fixture-saved-deepseek-key')
      expect(await key.getAttribute('type')).toBe('password')
      await compareOrRefreshGolden(
        fileURLToPath(new URL('./expected/credential-editor/saved-key.expected.md', import.meta.url)),
        await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode(),
      )
      await dialog.getByRole('button', { name: '显示密钥', exact: true }).click()
      expect(await key.getAttribute('type')).toBe('text')
      await key.fill('fixture-cancelled-key')
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      expect(await scaffold.ctx.credentials.readStored(ref)).toBe('fixture-saved-deepseek-key')
      await edit.click()
      await expect.poll(() => key.inputValue()).toBe('fixture-saved-deepseek-key')
      expect(await key.getAttribute('type')).toBe('password')
      await key.fill('fixture-replacement-key')
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await dialog.getByText('已保存 DeepSeek (deepseek-official)。', { exact: true }).waitFor()
      expect(await scaffold.ctx.credentials.readStored(ref)).toBe('fixture-replacement-key')
      await page.reload({ waitUntil: 'load' })
      await openSettings(page, 'zh')
      await dialog.getByRole('button', { name: '模型', exact: true }).click()
      await edit.click()
      await expect.poll(() => key.inputValue()).toBe('fixture-replacement-key')
      await key.fill('')
      expect(await key.getAttribute('placeholder')).toBe('留空使用环境认证（DEEPSEEK_API_KEY）')
      await dialog.getByText('环境凭据状态尚未确认', { exact: true }).waitFor()
      expect(await scaffold.ctx.credentials.readStored(ref)).toBe('fixture-replacement-key')
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await dialog.getByText('已保存 DeepSeek (deepseek-official)。', { exact: true }).waitFor()
      expect(await scaffold.ctx.credentials.readStored(ref)).toBeUndefined()
      // A missing credential opens the first-run settings card automatically;
      // an environment credential keeps an ordinary row whose editor is closed.
      if (hasEnvironment) await edit.click()
      await expect.poll(() => key.inputValue()).toBe('')
      expect(await key.getAttribute('placeholder')).toBe('留空使用环境认证（DEEPSEEK_API_KEY）')
      const hint = hasEnvironment
        ? '已检测到环境变量（DEEPSEEK_API_KEY）'
        : '未检测到环境变量。请填写 API 密钥，或设置环境变量 DEEPSEEK_API_KEY。'
      const detection = dialog.getByText(hint, { exact: true })
      await detection.waitFor()
      const colors = await detection.evaluate((element, present) => {
        const label = element as HTMLElement
        const actual = getComputedStyle(label).color
        const previous = label.style.color
        label.style.color = present ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-label)'
        const expected = getComputedStyle(label).color
        label.style.color = previous
        return { actual, expected }
      }, hasEnvironment)
      expect(colors.actual).toBe(colors.expected)
      expect(await dialog.getByRole('button', { name: '显示密钥', exact: true }).count()).toBe(0)
      expect((await scaffold.ctx.credentials.resolve(ref))?.source).toBe(hasEnvironment ? 'env' : undefined)
      await compareOrRefreshGolden(
        fileURLToPath(new URL(`./expected/credential-editor/${hasEnvironment ? 'detected' : 'missing'}-environment.expected.md`, import.meta.url)),
        await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode(),
      )
    } finally { await browser.close() }
  } finally { await scaffold.close() }
})

/** Local provider endpoint recording the destination path and authentication actually received. */
async function connectionProbe(messages: boolean) {
  const calls: { path: string; key: string | undefined }[] = []
  const server = createServer((request, response) => {
    request.on('end', () => {
      const key = messages ? request.headers['x-api-key'] : request.headers.authorization
      calls.push({ path: request.url ?? '', key: typeof key === 'string' ? key : undefined })
      const events = messages ? [
        { type: 'message_start', message: { id: 'probe', type: 'message', role: 'assistant', model: 'credential-editor-model', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'connection-ok' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ] : [
        { choices: [{ delta: { role: 'assistant', content: 'connection-ok' }, index: 0, finish_reason: null }] },
        { choices: [{ delta: {}, index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(events.map(event => `${'type' in event ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('')
        + (messages ? '' : 'data: [DONE]\n\n'))
    })
    request.resume()
  })
  onTestFinished(async () => {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('connection probe did not bind TCP')
  return { url: `http://127.0.0.1:${String(address.port)}`, calls }
}

it.each([
  { provider: 'deepseek-official', ref: 'DEEPSEEK_API_KEY', messages: true },
  { provider: 'openai', ref: 'OPENAI_API_KEY', messages: false },
  { provider: 'anthropic', ref: 'ANTHROPIC_API_KEY', messages: true },
  { provider: 'credential-fixture', ref: 'CREDENTIAL_FIXTURE_API_KEY', messages: false },
])('uses the saved endpoint and key on the wire for $provider, then restores fallbacks', async ({ provider, ref, messages }) => {
  const ambient = await connectionProbe(messages)
  const saved = await connectionProbe(messages)
  const root = await mkdtemp(join(tmpdir(), 'dsh-credential-routing-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const overlay = join(root, 'connection.patch.yml')
  const models = [{ id: 'credential-editor-model' }]
  const baseSuffix = provider === 'anthropic' ? '' : '/v1'
  const operation = provider === 'anthropic' ? '/v1/messages?beta=true' : messages ? '/messages' : '/chat/completions'
  const ambientURL = `${ambient.url}/ambient${baseSuffix}`
  await writeFile(overlay, JSON.stringify([
    { id: 'llm-deepseek', config: { models } },
    ...provider === 'deepseek-official' ? [] : [{
      id: 'llm-pi-ai', config: { providers: { [provider]: {
        api: messages ? 'anthropic-messages' : 'openai-completions',
        baseURL: ambientURL, models,
        ...provider === 'credential-fixture' ? {} : { apiKeyEnv: ref },
      } } },
    }],
  ]))
  const scaffold = await launchWebScaffold({
    deepSeekMissingCredential: true,
    extraOverlayPath: overlay,
    openInAppEnvironment: createLaunchEnvironmentSnapshot([{
      source: 'process', values: {
        [ref]: 'fixture-environment-key',
        DEEPSEEK_BASE_URL: ambientURL,
        OPENAI_BASE_URL: ambientURL,
        ANTHROPIC_BASE_URL: ambientURL,
      },
    }]),
  })
  try {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE })
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await openSettings(page, 'zh')
      const dialog = page.getByRole('dialog', { name: '设置' })
      await dialog.getByRole('button', { name: '模型', exact: true }).click()
      const edit = dialog.getByRole('button', {
        name: `编辑 ${provider === 'deepseek-official' ? 'DeepSeek (deepseek-official)' : provider}`, exact: true,
      })
      const key = dialog.getByLabel('API 密钥', { exact: true })
      const endpoint = dialog.getByLabel('API 地址', { exact: true })
      const savedURL = `${saved.url}/configured${baseSuffix}`
      const generate = async (): Promise<void> => {
        const assembler = new BlockAssembler()
        for await (const chunk of scaffold.ctx.llm.stream({ provider, model: 'credential-editor-model', messages: [] })) assembler.push(chunk)
        expect(assembler.message({ provider, model: 'credential-editor-model' }).content).toContainEqual({ type: 'text', text: 'connection-ok' })
      }
      await edit.click()
      await key.fill('fixture-saved-key')
      await dialog.getByText('自定义设置', { exact: true }).click()
      await endpoint.fill(savedURL)
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await expect.poll(() => key.count()).toBe(0)
      await generate()
      expect(saved.calls).toEqual([{ path: `/configured${baseSuffix}${operation}`, key: messages ? 'fixture-saved-key' : 'Bearer fixture-saved-key' }])
      expect(ambient.calls).toEqual([])
      await page.reload({ waitUntil: 'load' })
      await openSettings(page, 'zh')
      await dialog.getByRole('button', { name: '模型', exact: true }).click()
      await edit.click()
      expect(await key.inputValue()).toBe('fixture-saved-key')
      expect(await key.getAttribute('type')).toBe('password')
      await dialog.getByText('自定义设置', { exact: true }).click()
      expect(await endpoint.inputValue()).toBe(savedURL)
      await generate()
      expect(saved.calls).toHaveLength(2)
      expect(saved.calls[1]).toEqual(saved.calls[0])
      expect(ambient.calls).toEqual([])
      await key.fill('')
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await expect.poll(() => key.count()).toBe(0)
      await generate()
      expect(saved.calls).toHaveLength(3)
      expect(saved.calls[2]).toEqual({ path: `/configured${baseSuffix}${operation}`, key: messages ? 'fixture-environment-key' : 'Bearer fixture-environment-key' })
      expect(ambient.calls).toEqual([])
      await edit.click()
      await key.fill('fixture-saved-key')
      await dialog.getByText('自定义设置', { exact: true }).click()
      await endpoint.fill('')
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await expect.poll(() => key.count()).toBe(0)
      await generate()
      expect(saved.calls).toHaveLength(3)
      expect(ambient.calls).toEqual([{ path: `/ambient${baseSuffix}${operation}`, key: messages ? 'fixture-saved-key' : 'Bearer fixture-saved-key' }])
      await edit.click()
      await key.fill('')
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await expect.poll(() => key.count()).toBe(0)
      await generate()
      expect(saved.calls).toHaveLength(3)
      expect(ambient.calls[1]).toEqual({ path: `/ambient${baseSuffix}${operation}`, key: messages ? 'fixture-environment-key' : 'Bearer fixture-environment-key' })
      expect(ambient.calls).toHaveLength(2)
      expect(await scaffold.ctx.credentials.readStored(credentialRef(ref))).toBeUndefined()
    } finally { await browser.close() }
  } finally { await scaffold.close() }
})
