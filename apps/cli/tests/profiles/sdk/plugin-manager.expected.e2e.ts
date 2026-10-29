/** SDK plugin management persists changes while the live stdio process keeps its original composition. */
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { profileEnvironment } from './fixtures/profile-environment.ts'
import { messagesResponse } from './fixtures/messages-response.ts'

it.for(['standard', 'ptc'] as const)('keeps %s plugin changes pending until the SDK runtime restarts', async (mode, test) => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-plugin-manager-'))
  const requests: Record<string, unknown>[] = []
  let phase: 'list' | 'set' | 'done' = 'list'
  let changedAt = 0
  let fixtureError: unknown
  const listPage = z.object({
    entries: z.array(z.object({ entryId: z.string(), moduleName: z.string() })), nextOffset: z.number().nullable(),
  })
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      let args: Record<string, unknown> | undefined
      try {
        const current = JSON.parse(body) as Record<string, unknown>
        requests.push(current)
        if (requests.length === 1) args = { action: 'list_plugins', limit: 100 }
        else if (phase === 'list') {
          const messages = current.messages as { content: { type: string; content?: { text: string }[] }[] }[]
          const result = messages.flatMap(message => message.content).findLast(block => block.type === 'tool_result')
          const page = listPage.parse(JSON.parse(result!.content![0]!.text))
          const row = page.entries.find(entry => entry.moduleName === '@deepseek-ai/dsh-tool-web')
          if (row !== undefined) {
            args = { action: 'set_plugin', target: row.entryId, enabled: false }
            phase = 'set'
          } else if (page.nextOffset !== null) args = { action: 'list_plugins', offset: page.nextOffset, limit: 100 }
          else throw new Error('SDK plugin inventory omitted tool-web')
        } else if (phase === 'set') {
          changedAt = requests.length - 1
          phase = 'done'
        }
      } catch (error) { fixtureError = error }
      const call = mode === 'ptc'
        ? { type: 'tool_use', id: `manage-${requests.length}`, name: 'run_code', input: {
          code: `return await tools.plugin_manager(${JSON.stringify(args)});`, description: 'Disable web tools after restart',
        } }
        : { type: 'tool_use', id: `manage-${requests.length}`, name: 'plugin_manager', input: args }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(messagesResponse(args !== undefined ? call : { type: 'text', text: 'done' },
        args !== undefined ? 'tool_use' : 'end_turn'))
    })
  })
  test.onTestFinished(async () => {
    try {
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      }))
    }
    finally { await rm(root, { recursive: true, force: true }) }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('model fixture has no TCP address')
  const env = profileEnvironment(root, `http://127.0.0.1:${address.port}`)
  const options = {
    cwd: root, processCwd: root, dshHome: join(root, 'home'), env, model: 'deepseek-v4-pro',
    patches: mode === 'ptc' ? [fileURLToPath(new URL('../../../config/examples/ptc.yml', import.meta.url))] : [],
  }
  async function run(restarted: boolean): Promise<void> {
    const harness = new DeepSeekHarness(options)
    const abort = (): void => { void harness.close() }
    test.signal.addEventListener('abort', abort, { once: true })
    try {
      const session = harness.session(restarted ? 'restarted' : 'original')
      expect((await session.run('Disable web tools after restart')).finalResponse).toBe('done')
      if (!restarted) {
        expect((await session.run('Continue on the same connection')).finalResponse).toBe('done')
      }
    } finally {
      await harness.close()
      test.signal.removeEventListener('abort', abort)
    }
  }
  const advertises = (request: Record<string, unknown>, name: string): boolean => mode === 'ptc'
    ? JSON.stringify(request.system).includes(`${name}:`)
    : (request.tools as { name: string }[]).some(tool => tool.name === name)
  await run(false)
  expect(fixtureError).toBeUndefined()
  expect(changedAt).toBeGreaterThan(0)
  expect(advertises(requests[0]!, 'plugin_manager')).toBe(true)
  expect(JSON.stringify(requests[changedAt]!.messages)).toContain('restart-required')
  expect(JSON.stringify(requests[changedAt]!.messages)).toContain('no-hmr')
  expect(JSON.stringify(requests[changedAt]!.messages)).toContain('restart DSH')
  expect(advertises(requests.at(-1)!, 'web_fetch')).toBe(true)
  const saved = await readFile(join(root, 'home/profiles/sdk/cordis.patch.yml'), 'utf8')
  expect(saved).toContain('tool-web')
  expect(saved).toContain('disabled: true')
  await run(true)
  expect(advertises(requests.at(-1)!, 'web_fetch')).toBe(false)
  expect(advertises(requests.at(-1)!, 'plugin_manager')).toBe(true)
})

it.for(['unavailable', 'approved', 'missing-pnpm'] as const)('reports the %s plugin-management prerequisite', async (scenario, test) => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-plugin-prerequisite-'))
  const requests: Record<string, unknown>[] = []
  let fixtureError: unknown
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      try { requests.push(JSON.parse(body) as Record<string, unknown>) }
      catch (error) { fixtureError = error }
      const args = scenario === 'missing-pnpm'
        ? { action: 'install_bundle', target: '@deepseek-ai/dsh-subagent-codex' }
        : { action: 'list_plugins', limit: 1 }
      const call = { type: 'tool_use', id: 'prerequisite', name: 'plugin_manager', input: args }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(messagesResponse(requests.length === 1 ? call : { type: 'text', text: 'done' },
        requests.length === 1 ? 'tool_use' : 'end_turn'))
    })
  })
  test.onTestFinished(async () => {
    try { await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() })) }
    finally { await rm(root, { recursive: true, force: true }) }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('model fixture has no TCP address')
  const env = profileEnvironment(root, `http://127.0.0.1:${address.port}`)
  env.DSH_PERMISSION_MODE = scenario === 'missing-pnpm' ? 'danger-full-access' : 'workspace-write'
  if (scenario === 'missing-pnpm') {
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') Reflect.deleteProperty(env, key)
    env.PATH = root
  }
  const harness = new DeepSeekHarness({ cwd: root, processCwd: root, dshHome: join(root, 'home'),
    env, model: 'deepseek-v4-pro', approvalRequests: scenario === 'approved' })
  let approvals = 0
  const abort = (): void => { void harness.close() }
  test.signal.addEventListener('abort', abort, { once: true })
  try {
    harness.client.start()
    harness.client.onRequest(async (method) => {
      expect(method).toBe('approval/request')
      approvals++
      return { outcome: 'allowed-once' }
    })
    expect((await harness.run('Check plugin prerequisites')).finalResponse).toBe('done')
    expect(fixtureError).toBeUndefined()
    const result = JSON.stringify(requests.at(-1)?.messages)
    if (scenario === 'unavailable') expect(result).toContain('unavailable')
    else if (scenario === 'missing-pnpm') {
      const messages = requests.at(-1)!.messages as { content: { type: string; content?: { text: string }[] }[] }[]
      const toolResult = messages.flatMap(message => message.content).findLast(block => block.type === 'tool_result')
      const failure = z.object({
        changed: z.literal(false), application: z.literal('failed'),
        packageResult: z.object({ exitCode: z.number(), output: z.string().min(1) }),
        error: z.object({ code: z.literal('operation-error'), diagnostic: z.string().min(1) }),
      }).parse(JSON.parse(toolResult!.content![0]!.text))
      // cmd.exe reports 1 for a missing command; POSIX spawn reports 127.
      expect(failure.packageResult.exitCode).toBe(process.platform === 'win32' ? 1 : 127)
      expect(failure.error.diagnostic).toContain('pnpm')
      expect(failure.packageResult.output).toContain(failure.error.diagnostic)
    } else { expect(approvals).toBe(1); expect(result).toContain('entries') }
    const manifest = JSON.parse(await readFile(join(root, 'home/profiles/sdk/package.json'), 'utf8')) as { dependencies: object }
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([])
  } finally {
    await harness.close()
    test.signal.removeEventListener('abort', abort)
  }
})
