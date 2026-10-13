/** Credential selection through the shipped headless profile and real HTTP adapters. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { describe, expect, it } from 'vitest'

const binScript = fileURLToPath(new URL('../../../../../../apps/cli/src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url))
const savedKey = 'headless-saved-key'
const launchKey = 'headless-launch-key'
const projectKey = 'headless-project-key'
const homeKey = 'headless-home-key'
const processTimeoutMs = 60_000

/** Anthropic SDK events require the SSE event name beside the JSON payload. */
async function startAnthropicServer() {
  const keys: Array<string | string[] | undefined> = []
  const server = createServer((request, response) => {
    keys.push(request.headers['x-api-key'])
    request.resume()
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of [
      { type: 'message_start', message: { id: 'auth-test', type: 'message', role: 'assistant', model: 'headless-auth-model', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'mock response recovered' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    response.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    keys,
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      }))
    },
  }
}

const credentials = JSON.stringify({
  version: 1,
  refs: { DEEPSEEK_API_KEY: savedKey, ANTHROPIC_API_KEY: savedKey },
  records: {
    'llm-pi-ai/anthropic': { kind: 'api-key', key: savedKey },
    'llm-pi-ai/openai-codex': {
      kind: 'grant', payload: { type: 'oauth', access: 'headless-saved-access', refresh: 'headless-saved-refresh', expires: 1 },
    },
  },
}) + '\n'

describe('headless credential policy', { retry: 0 }, () => {
  it.each([
    { name: 'launch environment', launch: launchKey, project: projectKey, home: homeKey, expected: launchKey },
    { name: 'project .env', launch: undefined, project: projectKey, home: homeKey, expected: projectKey },
    { name: 'home .env', launch: undefined, project: undefined, home: homeKey, expected: homeKey },
  ])('uses $name instead of saved credentials', async (scenario) => {
    const server = await startMockLlmServer({ sequence: ['success'], repeatLast: true, apiKey: scenario.expected })
    try {
      const result = await runLoaderSmoke({
        label: `headless credentials: ${scenario.name}`,
        tempDirPrefix: 'headless-credentials-', binScript, tsconfigPath, sourceImport: 'tsx/esm',
        configPath: '', binArgs: ['headless', 'Reply briefly.'], processTimeoutMs,
        env: {
          DEEPSEEK_API_KEY: scenario.launch, DEEPSEEK_BASE_URL: server.baseURL, DSH_TELEMETRY_DISABLED: '1',
        },
        prepare: async (cwd) => {
          await mkdir(join(cwd, '.dsh'), { recursive: true })
          await writeFile(join(cwd, '.dsh', '.credentials.yaml'), credentials, { mode: 0o600 })
          if (scenario.project !== undefined) await writeFile(join(cwd, '.env'), `DEEPSEEK_API_KEY=${scenario.project}\n`)
          if (scenario.home !== undefined) await writeFile(join(cwd, '.dsh', '.env'), `DEEPSEEK_API_KEY=${scenario.home}\n`)
        },
        inspect: async (cwd) => {
          expect(await readFile(join(cwd, '.dsh', '.credentials.yaml'), 'utf8')).toBe(credentials)
        },
      })
      expect(result.stdout.trim()).toBe('mock response recovered')
      expect(result.stderr).toBe('')
      expect(server.requests.length).toBeGreaterThan(0)
      expect(server.requests.every(request => request.headers['x-api-key'] === scenario.expected)).toBe(true)
    } finally {
      await server.close()
    }
  }, processTimeoutMs + 15_000)

  it.each(['named reference', 'native discovery'] as const)('uses launch credentials for pi-ai %s', async (mode) => {
    const server = await startAnthropicServer()
    try {
      const result = await runLoaderSmoke({
        label: `headless pi-ai credentials: ${mode}`,
        tempDirPrefix: 'headless-pi-credentials-', binScript, tsconfigPath, sourceImport: 'tsx/esm',
        configPath: '', binArgs: ['headless', '--patch', './auth.patch.json', 'Reply briefly.'], processTimeoutMs,
        env: {
          ANTHROPIC_API_KEY: launchKey, ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_OAUTH_TOKEN: undefined,
          ANTHROPIC_FEDERATION_RULE_ID: undefined, ANTHROPIC_ORGANIZATION_ID: undefined,
          ANTHROPIC_IDENTITY_TOKEN_FILE: undefined, ANTHROPIC_SERVICE_ACCOUNT_ID: undefined, ANTHROPIC_WORKSPACE_ID: undefined,
          DEEPSEEK_API_KEY: undefined, DSH_TELEMETRY_DISABLED: '1',
        },
        prepare: async (cwd) => {
          await mkdir(join(cwd, '.dsh'), { recursive: true })
          await writeFile(join(cwd, '.dsh', '.credentials.yaml'), credentials, { mode: 0o600 })
          await writeFile(join(cwd, 'auth.patch.json'), JSON.stringify([
            { id: 'agent-default-model', config: { provider: 'anthropic', model: 'headless-auth-model' } },
            { id: 'llm-pi-ai', config: { providers: { anthropic: {
              ...mode === 'named reference' ? { apiKeyEnv: 'ANTHROPIC_API_KEY' } : {},
              baseURL: server.baseURL,
              models: [{ id: 'headless-auth-model', contextWindow: 32_768, maxTokens: 1024 }],
            } } } },
          ]))
        },
        inspect: async (cwd) => {
          expect(await readFile(join(cwd, '.dsh', '.credentials.yaml'), 'utf8')).toBe(credentials)
        },
      })
      expect(result.stdout.trim()).toBe('mock response recovered')
      expect(result.stderr).toBe('')
      expect(server.keys.length).toBeGreaterThan(0)
      expect(server.keys.every(key => key === launchKey)).toBe(true)
    } finally {
      await server.close()
    }
  }, processTimeoutMs + 15_000)

  it.each(['no environment key', 'empty environment key', 'invalid stored document', 'restore stored credentials'] as const)('%s', async (mode) => {
    const restoring = mode === 'restore stored credentials'
    const empty = mode === 'empty environment key'
    const missing = mode === 'no environment key' || empty
    const document = mode === 'invalid stored document' ? 'invalid: [\n' : credentials
    const server = await startMockLlmServer({ sequence: ['success'], repeatLast: true, apiKey: restoring ? savedKey : launchKey })
    try {
      const result = await runLoaderSmoke({
        label: `headless credential boundary: ${mode}`,
        tempDirPrefix: 'headless-credential-boundary-', binScript, tsconfigPath, sourceImport: 'tsx/esm',
        configPath: '',
        binArgs: ['headless', ...restoring ? ['--patch', './auth.patch.json'] : [], 'Reply briefly.'],
        processTimeoutMs, expectedExitCode: missing ? 1 : 0,
        env: { DEEPSEEK_API_KEY: empty ? '' : missing ? undefined : launchKey, DEEPSEEK_BASE_URL: server.baseURL, DSH_TELEMETRY_DISABLED: '1' },
        prepare: async (cwd) => {
          await mkdir(join(cwd, '.dsh'), { recursive: true })
          await writeFile(join(cwd, '.dsh', '.credentials.yaml'), document, { mode: 0o600 })
          if (empty) await writeFile(join(cwd, '.env'), `DEEPSEEK_API_KEY=${projectKey}\n`)
          if (restoring) await writeFile(join(cwd, 'auth.patch.json'), JSON.stringify(
            ['credentials', 'authorization', 'deepseek-account'].map(id => ({ id, disabled: false })),
          ))
        },
        inspect: async (cwd) => {
          expect(await readFile(join(cwd, '.dsh', '.credentials.yaml'), 'utf8')).toBe(document)
        },
      })
      if (missing) {
        expect(result.stdout).toBe('\n')
        expect(result.stderr).toContain('MISSING_CREDENTIAL')
        expect(server.requests).toHaveLength(0)
      } else {
        expect(result.stdout.trim()).toBe('mock response recovered')
        expect(result.stderr).toBe('')
        expect(server.requests.length).toBeGreaterThan(0)
      }
    } finally {
      await server.close()
    }
  }, processTimeoutMs + 15_000)

  it.each([
    { provider: 'deepseek-account', model: 'deepseek-v4-flash', code: 'ACCOUNT_SIGN_IN_REQUIRED' },
    { provider: 'openai-codex', model: 'gpt-5.4', code: 'PI_AI_ERROR: Provider is not configured: openai-codex' },
  ])('fails without saved sign-in for $provider', async ({ provider, model, code }) => {
    const result = await runLoaderSmoke({
      label: `headless saved sign-in: ${provider}`,
      tempDirPrefix: 'headless-saved-sign-in-', binScript, tsconfigPath, sourceImport: 'tsx/esm',
      configPath: '', binArgs: ['headless', '--patch', './auth.patch.json', 'Reply briefly.'],
      processTimeoutMs, expectedExitCode: 1,
      env: { DEEPSEEK_API_KEY: undefined, OPENAI_API_KEY: undefined, DSH_TELEMETRY_DISABLED: '1' },
      prepare: async (cwd) => {
        await mkdir(join(cwd, '.dsh'), { recursive: true })
        await writeFile(join(cwd, '.dsh', '.credentials.yaml'), credentials, { mode: 0o600 })
        await writeFile(join(cwd, 'auth.patch.json'), JSON.stringify([
          { id: 'agent-default-model', config: { provider, model } },
          ...provider === 'openai-codex' ? [{ id: 'llm-pi-ai', config: { providers: {
            [provider]: { models: [{ id: model, contextWindow: 32_768, maxTokens: 1024 }] },
          } } }] : [],
        ]))
      },
      inspect: async (cwd) => {
        expect(await readFile(join(cwd, '.dsh', '.credentials.yaml'), 'utf8')).toBe(credentials)
      },
    })
    expect(result.stdout).toBe('\n')
    expect(result.stderr).toContain(code)
    expect(result.stderr).not.toContain('pending')
  }, processTimeoutMs + 15_000)
})
