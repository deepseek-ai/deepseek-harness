/** Account catalog diagnostics preserve the shipped ACP profile's JSON-RPC stream. */
import { once } from 'node:events'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { launchAcpTestAgent, type AgentUnderTest, type LaunchedAcpTestAgent } from '@deepseek-ai/dsh-session-snapshot'
import { expect, it } from 'vitest'
import { cleanupAcpExampleTest } from './cleanup.ts'

it('keeps account model-listing diagnostics on stderr during API-key session creation', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-stdout-'))
  const token = 'acp-catalog-fixture-token'
  const requests: Array<{ method: string | undefined; path: string | undefined; token: string | string[] | undefined }> = []
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url, token: request.headers['x-dsh-auth-token'] })
    request.resume()
    if (request.method !== 'GET' || request.url !== '/models') {
      response.writeHead(500).end('unexpected request')
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      data: [
        {
          id: 'deepseek-flash', name: 'Account fixture model', input_modalities: ['text'], output_modalities: ['text'],
          context_window: 1_048_576, max_output_tokens: 393_216, api_capabilities: { anthropic_messages: {} },
        },
        { id: 'deepseek-v4-pro' },
      ],
    }))
  })
  let launched: LaunchedAcpTestAgent | undefined
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('account catalog server has no port')
    const origin = `http://127.0.0.1:${address.port}`
    await mkdir(join(cwd, '.dsh'))
    await writeFile(join(cwd, '.dsh', '.credentials.yaml'), JSON.stringify({
      version: 1,
      records: {
        'deepseek-account-platform/default': { kind: 'grant', payload: { version: 1, token, issuer: origin } },
      },
    }) + '\n', { mode: 0o600 })
    const configPath = join(cwd, 'catalog.patch.yml')
    await writeFile(configPath, JSON.stringify([
      { id: 'deepseek-account', config: { platformOrigin: origin, inferenceOrigin: origin, allowLoopbackHttp: true } },
      { id: 'llm-deepseek-account', config: { baseURL: `${origin}/anthropic` } },
      { id: 'llm-deepseek', config: { baseURL: `${origin}/anthropic`, models: [{ id: 'fixture-api-key-model' }] } },
      // Catalog discovery requires the account service to have loaded the stored grant.
      {
        id: 'acp', inject: ['acpAppStartup', 'deepseekAccount'],
        config: { provider: 'deepseek-official', model: 'fixture-api-key-model' },
      },
      { id: 'session-persistence-jsonl', config: { root: join(cwd, 'sessions'), compression: 'none' } },
    ]) + '\n')
    const agent: AgentUnderTest = {
      binScript: fileURLToPath(new URL('../../../../src/bin.ts', import.meta.url)),
      configPath,
      profile: 'acp',
      tsconfigPath: fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url)),
    }
    launched = launchAcpTestAgent({
      agent,
      cwd,
      env: { DEEPSEEK_API_KEY: 'acp-fixture-api-key', DEEPSEEK_BASE_URL: `${origin}/anthropic`, DSH_TELEMETRY_DISABLED: '1' },
    })
    await launched.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await launched.client.newSession({ cwd, mcpServers: [] })
    expect(created.configOptions).toContainEqual(expect.objectContaining({
      id: 'model', currentValue: JSON.stringify(['deepseek-official', 'fixture-api-key-model']),
    }))
    await launched.client.closeSession({ sessionId: created.sessionId })
    // Closing joins both pipes; receiving a stdout response alone does not drain stderr.
    await launched.close()

    expect(launched.child.signalCode).toBeNull()
    expect(launched.child.exitCode).toBe(0)
    expect(requests).toEqual([{ method: 'GET', path: '/models', token }])
    const frames = launched.rawStdout().trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(frames.length).toBeGreaterThanOrEqual(3)
    for (const frame of frames) expect(frame).toMatchObject({ jsonrpc: '2.0' })
    expect(launched.stderr()).toContain(`[llm-deepseek-account] model listing from ${origin}/models loaded 2 model(s), skipped 0 row(s)`)
    expect(launched.stderr()).toContain('[llm-deepseek-account] model "deepseek-v4-pro" declares no api_capabilities.anthropic_messages')
    expect(launched.stderr()).not.toContain(token)
  } finally {
    const cleanup = await Promise.allSettled([cleanupAcpExampleTest(launched, cwd)])
    server.closeAllConnections()
    cleanup.push(...await Promise.allSettled([
      server.listening ? new Promise<void>((resolve, reject) => server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })) : undefined,
    ]))
    const failures: unknown[] = []
    for (const result of cleanup) if (result.status === 'rejected') failures.push(result.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'ACP catalog test cleanup failed')
  }
})
