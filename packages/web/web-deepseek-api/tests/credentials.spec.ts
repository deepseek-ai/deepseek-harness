/** API-key resolution for the Search and Fetch API providers through the credential and launch-environment planes. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as webApiPlugin from '@deepseek-ai/dsh-web-deepseek-api'

const BASE = 'https://api.deepseek.test/v1/tools'

/** Stub the Search API and read back the bearer credential of every dispatched request. */
function captureAuthorization(): () => (string | null)[] {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
    JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } },
  ))
  vi.stubGlobal('fetch', fetchMock)
  return () => fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'))
}

/**
 * Mount the web seam and the plugin with a fixed launch environment, so no ambient key leaks in.
 * @param ctx - the root context.
 * @param config - plugin configuration.
 * @param environment - launch-environment variables.
 */
async function mount(ctx: Context, config: Record<string, unknown>, environment: Record<string, string>): Promise<void> {
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: environment }]))
  await ctx.plugin(WebRuntime, { searchProvider: 'deepseek-search-api' })
  await ctx.plugin(webApiPlugin, { baseURL: BASE, ...config })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('web-deepseek-api API-key resolution', () => {
  it('resolves the referenced credential for each request, so a stored or rotated key needs no restart', async () => {
    const authorization = captureAuthorization()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-web-deepseek-api-credentials-'))
    const ctx = new Context()
    try {
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await mount(ctx, {}, {})
      const missing = ctx.web.search({ query: 'missing' })
      await expect(missing).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
      await expect(missing).rejects.toThrow(/"apiKey" in the web-deepseek-api config/)
      const ref = credentialRef('DEEPSEEK_API_KEY')
      await ctx.credentials.set(ref, 'stored-key')
      await ctx.web.search({ query: 'stored' })
      await ctx.credentials.set(ref, 'rotated-key')
      await ctx.web.search({ query: 'rotated' })
      expect(authorization()).toEqual(['Bearer stored-key', 'Bearer rotated-key'])
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.each([
    ['the default reference', {}, { DEEPSEEK_API_KEY: 'env-key' }, 'Bearer env-key'],
    ['a configured reference', { apiKeyEnv: 'SEARCH_API_KEY' }, { SEARCH_API_KEY: 'custom-key' }, 'Bearer custom-key'],
    ['an empty literal key', { apiKey: '' }, { DEEPSEEK_API_KEY: 'env-key' }, 'Bearer env-key'],
  ])('falls back to the launch environment for %s without a credentials service', async (_case, config, environment, expected) => {
    const authorization = captureAuthorization()
    const ctx = new Context()
    try {
      await mount(ctx, config, environment)
      await ctx.web.search({ query: 'q' })
      expect(authorization()).toEqual([expected])
    } finally { await ctx.fiber.dispose() }
  })

  it('treats an empty environment value as missing', async () => {
    const authorization = captureAuthorization()
    const ctx = new Context()
    try {
      await mount(ctx, {}, { DEEPSEEK_API_KEY: '' })
      await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
      expect(authorization()).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('treats an empty credential value as missing', async () => {
    const authorization = captureAuthorization()
    const ctx = new Context()
    try {
      ctx.provide('credentials', { resolve: async () => ({ value: '' }) } as never)
      await mount(ctx, {}, {})
      await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
      expect(authorization()).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })
})
