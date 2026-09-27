/** Runtime template values and HTTP requests remain bound to their MCP session. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { CredentialProvider, credentialRef } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo, CredentialRecord, CredentialRecordEntry, CredentialRecordInfo, CredentialRef, ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { Config, probeServer } from '@deepseek-ai/dsh-mcp-client'
import { McpTemplateBinding } from '@deepseek-ai/dsh-mcp-client/src/credentials.ts'
import { startHttpMcpFixture } from './http-fixture.ts'

class TestCredentials extends CredentialProvider {
  values = new Map<string, string>()

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'fixture' })
  }

  describe(): Promise<CredentialInfo> { throw new Error('unexpected credential description') }
  set(): Promise<void> { throw new Error('unexpected credential write') }
  unset(): Promise<void> { throw new Error('unexpected credential removal') }
  readRecord(): Promise<CredentialRecord | undefined> { throw new Error('unexpected record read') }
  describeRecord(): Promise<CredentialRecordInfo> { throw new Error('unexpected record description') }
  listRecords(): Promise<readonly CredentialRecordEntry[]> { throw new Error('unexpected record listing') }
  modifyRecord(): Promise<CredentialRecord | undefined> { throw new Error('unexpected record write') }
  deleteRecord(): Promise<void> { throw new Error('unexpected record removal') }
}

const ref = credentialRef('MCP_TOKEN')
const url = 'https://mcp.invalid/fixture'

function httpConfig(): Config {
  return Config({ transport: 'streamable-http', serverName: 'binding', url,
    headers: { Authorization: 'Bearer ${credential:MCP_TOKEN}' }, expandTemplates: true })
}

describe('McpTemplateBinding', () => {
  let ctx: Context
  let provider: TestCredentials
  let providerFiber: Fiber

  beforeEach(async () => {
    ctx = new Context()
    providerFiber = await ctx.plugin(TestCredentials)
    provider = ctx.credentials as TestCredentials
    provider.values.set(ref, 'first-token')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await ctx.fiber.dispose()
  })

  it('requires a provider when binding credential templates', async () => {
    await providerFiber.dispose()
    expect(() => new McpTemplateBinding(ctx, httpConfig())).toThrow('require a credentials provider')
  })

  it('resolves repeated references once per pass while keeping configuration unexpanded', async () => {
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
      { source: 'process', values: { MCP_EXECUTABLE: 'fixture-command' } },
    ]))
    const config = Config({ transport: 'stdio', serverName: 'binding', expandTemplates: true,
      command: '${env:MCP_EXECUTABLE}', args: ['${credential:MCP_TOKEN}', '${credential:MCP_TOKEN}'],
      env: { TOKEN: '${credential:MCP_TOKEN}' }, cwd: '${env:MCP_EXECUTABLE}' })
    const binding = new McpTemplateBinding(ctx, config)
    const resolve = vi.spyOn(provider, 'resolve')
    const signal = new AbortController().signal
    expect(await binding.resolve(signal)).toMatchObject({ command: 'fixture-command',
      args: ['first-token', 'first-token'], env: { TOKEN: 'first-token' }, cwd: 'fixture-command' })
    expect(resolve).toHaveBeenCalledExactlyOnceWith(ref)
    expect(config).toMatchObject({ args: ['${credential:MCP_TOKEN}', '${credential:MCP_TOKEN}'] })
    provider.values.set(ref, 'next-token')
    expect(await binding.resolve(signal)).toMatchObject({ args: ['next-token', 'next-token'] })
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('reports a provider unloaded after binding creation without sending a request', async () => {
    const binding = new McpTemplateBinding(ctx, httpConfig())
    const bound = await binding.resolve(new AbortController().signal)
    await providerFiber.dispose()
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected HTTP request'))
    await expect(binding.fetch(bound, url, undefined, new AbortController().signal)).rejects.toThrow('require a credentials provider')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects a missing credential before sending and requests a binding refresh', async () => {
    const binding = new McpTemplateBinding(ctx, httpConfig())
    const signal = new AbortController().signal
    const bound = await binding.resolve(signal)
    const changed = vi.fn()
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected HTTP request'))
    provider.values.delete(ref)
    await expect(binding.fetch(bound, url, undefined, signal, changed)).rejects.toThrow('credential "MCP_TOKEN" is not configured')
    expect(changed).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses to send changed credentials through an existing session', async () => {
    const binding = new McpTemplateBinding(ctx, httpConfig())
    const signal = new AbortController().signal
    const bound = await binding.resolve(signal)
    const changed = vi.fn()
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected HTTP request'))
    provider.values.set(ref, 'next-token')
    await expect(binding.fetch(bound, url, undefined, signal, changed)).rejects.toThrow('credential binding changed')
    expect(changed).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
    expect(bound).toMatchObject({ headers: { Authorization: 'Bearer first-token' } })
  })

  it.each(['generation', 'request'] as const)('propagates %s cancellation to the HTTP request', async (source) => {
    const binding = new McpTemplateBinding(ctx, httpConfig())
    const generation = new AbortController()
    const request = new AbortController()
    const bound = await binding.resolve(generation.signal)
    const sent: PromiseWithResolvers<AbortSignal> = Promise.withResolvers()
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(input).toBe(url)
      const signal = init?.signal
      if (signal === undefined || signal === null) throw new Error('missing request signal')
      sent.resolve(signal)
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new DOMException('The request was aborted', 'AbortError')) }, { once: true })
      })
    })
    const pending = binding.fetch(bound, url, source === 'generation' ? undefined : { signal: request.signal }, generation.signal)
    const failure = expect(pending).rejects.toThrow('HTTP request')
    try {
      const signal = await sent.promise
      expect(signal.aborted).toBe(false)
      const controller = source === 'generation' ? generation : request
      controller.abort(new Error('fixture cancellation'))
      await failure
      expect(signal.aborted).toBe(true)
      expect(fetch).toHaveBeenCalledOnce()
    } finally {
      generation.abort()
      await pending.catch(() => undefined)
    }
  })

  it('probes with expanded HTTP credentials without calling any tool', async () => {
    const server = await startHttpMcpFixture()
    try {
      const config = Config({ ...httpConfig(), transport: 'streamable-http', url: server.url })
      const result = await probeServer(ctx, config)
      expect(result).toMatchObject({ ok: true, toolNames: ['ping'], closeConfirmed: true })
      expect(result.cleanupError).toBeUndefined()
      expect(server.authorization.length).toBeGreaterThan(0)
      expect(server.authorization.every(value => value === 'Bearer first-token')).toBe(true)
      expect(server.calls).toEqual([])
    } finally {
      await server.close()
    }
  })
})
