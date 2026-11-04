/** Schedule authoring and restart delivery must honor the shipped SDK composition. */
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
        input: { title: 'Check SDK', prompt: 'Report the SDK reminder',
          rrule: 'DTSTART:20300102T000000Z\nRRULE:FREQ=DAILY;COUNT=1', target: 'this_session' },
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
  expect(await first.session('saved').run('Set a reminder')).toMatchObject({ finalResponse: 'ready' })
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
  expect(await session.run('Continue after the reminder')).toMatchObject({ finalResponse: 'ready' })
})

it('refuses new Session destinations before storing tasks in the shipped SDK profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-schedule-targets-'))
  const requests: Record<string, unknown>[] = []
  const calls = ['new', 'new_once', 'this_session'].flatMap(target => [
    { type: 'tool_use', id: `create-${target}`, name: 'schedule_create',
      input: { title: `SDK ${target}`, prompt: 'Check SDK',
        rrule: 'DTSTART:20300102T000000Z\nRRULE:FREQ=DAILY;COUNT=1', target } },
    { type: 'tool_use', id: `list-${target}`, name: 'schedule_list', input: {} },
  ])
  const server = createServer((incoming, response) => {
    let body = ''
    incoming.setEncoding('utf8')
    incoming.on('data', (chunk: string) => { body += chunk })
    incoming.on('end', () => {
      const content = calls[requests.length] ?? { type: 'text', text: 'ready' }
      requests.push(JSON.parse(body) as Record<string, unknown>)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(messagesResponse(content, content.type === 'tool_use' ? 'tool_use' : 'end_turn'))
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
  const client = new DeepSeekHarness({ cwd: root, dshHome: join(root, '.dsh'),
    model: 'deepseek-v4-pro', initializeTimeoutMs: 30_000, env })
  clients.push(client)
  expect((await client.session('schedule-owner').run('Check the supported schedule destinations')).finalResponse).toBe('ready')
  expect(requests).toHaveLength(calls.length + 1)
  const results = calls.map((call, index) => {
    const messages = requests[index + 1]?.messages as {
      content: { type: string; tool_use_id?: string; content?: { type: string; text?: string }[] }[]
    }[]
    const result = messages.flatMap(message => message.content)
      .find(block => block.type === 'tool_result' && block.tool_use_id === call.id)
    const text = result?.content?.find(block => block.type === 'text')?.text
    if (text === undefined) throw new Error(`SDK model request has no result for ${call.id}`)
    return JSON.parse(text) as Record<string, unknown>
  })
  for (const index of [0, 2]) {
    expect(results[index]).toMatchObject({
      code: 'invalid_rule', message: expect.stringContaining('choose an existing Session target') as string,
    })
    expect(results[index + 1]).toMatchObject({ items: [], shown: 0, total: 0 })
  }
  expect(results[4]).toMatchObject({ title: 'SDK this_session', target: { kind: 'session', sessionId: 'schedule-owner' } })
  expect(results[5]).toMatchObject({ items: [results[4]], shown: 1, total: 1 })
})
