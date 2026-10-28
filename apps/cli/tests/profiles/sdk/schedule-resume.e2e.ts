/** Reminder activation must share SDK ownership and initialized model limits after process restart. */
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { clearAmbientProxyEnv } from '../../../../../scripts/test-proxy-environment.ts'
import { expect, it, onTestFinished, vi } from 'vitest'
import { messagesResponse } from './fixtures/messages-response.ts'

it('delivers an overdue reminder with the SDK route and lets the client resume that same Session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-schedule-resume-'))
  const patch = join(root, 'clock.patch.yml')
  const fixture = fileURLToPath(new URL('./fixtures/schedule-clock.mjs', import.meta.url))
  await writeFile(patch, [
    '- insert:', '    - id: sdk-test-clock', `      name: ${JSON.stringify(fixture)}`,
    '- id: sdk-jsonrpc-server', '  inject: [sdkAppStartup, loader, sdkTestClock]', '',
  ].join('\n'))
  const requests: Record<string, unknown>[] = []
  const restored: Record<string, unknown>[] = []
  let restarting = false
  const server = createServer((incoming, response) => {
    let body = ''
    incoming.setEncoding('utf8')
    incoming.on('data', (chunk: string) => { body += chunk })
    incoming.on('end', () => {
      const request = JSON.parse(body) as Record<string, unknown>
      requests.push(request)
      if (restarting) restored.push(request)
      const content = requests.length === 1 ? {
        type: 'tool_use', id: 'create-reminder', name: 'schedule_create',
        input: { title: 'Check SDK', prompt: 'Report the SDK reminder', after_seconds: 86400 },
      } : { type: 'text', text: 'ready' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(messagesResponse(content, requests.length === 1 ? 'tool_use' : 'end_turn'))
    })
  })
  const clients: DeepSeekHarness[] = []
  onTestFinished(async () => {
    try { await Promise.all(clients.map(client => client.close())) } finally {
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => { if (error === undefined) resolve(); else reject(error) })
        })
      } finally { await rm(root, { recursive: true, force: true }) }
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('model fixture has no port')
  const env = { ...process.env, DSH_PERMISSION_MODE: 'danger-full-access', DSH_TELEMETRY_DISABLED: '1',
    DEEPSEEK_API_KEY: 'keyless-schedule-fixture', DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(address.port)}` }
  clearAmbientProxyEnv(env)
  const first = new DeepSeekHarness({ cwd: root, dshHome: join(root, '.dsh'), patches: [patch],
    model: 'deepseek-v4-pro', maxTokens: 5678, initializeTimeoutMs: 30_000,
    env: { ...env, DSH_TEST_SCHEDULE_NOW: String(Date.parse('2030-01-01T00:00:00Z')) } })
  clients.push(first)
  expect((await first.session('saved').run('Set a reminder')).finalResponse).toBe('ready')
  expect(requests).toHaveLength(2)
  await first.close()
  restarting = true
  const second = new DeepSeekHarness({ cwd: root, dshHome: join(root, '.dsh'), patches: [patch],
    model: 'deepseek-v4-flash', maxTokens: 1234, initializeTimeoutMs: 30_000,
    env: { ...env, DSH_TEST_SCHEDULE_NOW: String(Date.parse('2030-01-03T00:00:00Z')) } })
  clients.push(second)
  await second.start()
  await vi.waitFor(() => { expect(restored).toHaveLength(1) }, { timeout: 30_000 })
  expect(restored[0]).toMatchObject({ model: 'deepseek-v4-flash', max_tokens: 1234 })
  const session = await second.resumeSession('saved')
  expect((await session.run('Continue after the reminder')).finalResponse).toBe('ready')
})
