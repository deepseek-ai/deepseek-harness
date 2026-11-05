/** Shared credential resolution and metadata-only readiness across DeepSeek consumers. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { deepSeekApiKeyConfigured, rejectDeepSeekAccountToken, resolveDeepSeekAccountToken, resolveDeepSeekApiKey } from '../src/credential.ts'

const ref = credentialRef('TEST_DEEPSEEK_KEY')

function context(value?: string): Context {
  const ctx = new Context()
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
    { source: 'process', values: value === undefined ? {} : { [ref]: value } },
  ]))
  return ctx
}

describe('shared DeepSeek credentials', () => {
  it.each([undefined, '', '  valid-key  '])('reads the launch environment only without credentials: %j', async (value) => {
    const ctx = context(value)
    try {
      await expect(resolveDeepSeekApiKey(ctx, ref)).resolves.toBe(value ? value.trim() : undefined)
      await expect(deepSeekApiKeyConfigured(ctx, ref)).resolves.toBe(Boolean(value))
    } finally { await ctx.fiber.dispose() }
  })

  it('treats the installed service as authoritative and reads no value for configured', async () => {
    const ctx = context('ambient-key')
    const resolve = vi.fn(async () => undefined)
    const describe = vi.fn(async () => ({ configured: false }))
    ctx.provide('credentials', { resolve, describe } as never)
    try {
      await expect(deepSeekApiKeyConfigured(ctx, ref)).resolves.toBe(false)
      expect(resolve).not.toHaveBeenCalled()
      await expect(resolveDeepSeekApiKey(ctx, ref)).resolves.toBeUndefined()
      expect(resolve).toHaveBeenCalledExactlyOnceWith(ref)
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['bad key', '非法密钥', 'bad\nkey', '   '])('rejects malformed environment keys without exposing the value: %j', async (value) => {
    const ctx = context(value)
    try {
      await expect(resolveDeepSeekApiKey(ctx, ref)).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
    } finally { await ctx.fiber.dispose() }
  })

  it('validates and normalizes each stored key without caching it', async () => {
    const ctx = context('ambient-key')
    const resolve = vi.fn().mockResolvedValueOnce({ value: ' stored-key ' }).mockResolvedValueOnce({ value: 'bad key' })
    ctx.provide('credentials', { resolve } as never)
    try {
      await expect(resolveDeepSeekApiKey(ctx, ref)).resolves.toBe('stored-key')
      await expect(resolveDeepSeekApiKey(ctx, ref)).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
    } finally { await ctx.fiber.dispose() }
  })

  it('delegates account destination checks and contains token-removal failures', async () => {
    const ctx = context()
    try {
      await expect(resolveDeepSeekAccountToken(ctx, 'https://allowed.test')).resolves.toBeUndefined()
      await expect(rejectDeepSeekAccountToken(ctx, 'old-token')).resolves.toBeUndefined()
      const resolveToken = vi.fn(async () => 'account-token')
      const rejectToken = vi.fn(async () => { throw new Error('storage failed') })
      ctx.provide('deepseekAccount', { resolveToken, rejectToken } as never)
      await expect(resolveDeepSeekAccountToken(ctx, 'https://allowed.test')).resolves.toBe('account-token')
      expect(resolveToken).toHaveBeenCalledExactlyOnceWith('https://allowed.test')
      await expect(rejectDeepSeekAccountToken(ctx, 'old-token')).resolves.toBeUndefined()
      expect(rejectToken).toHaveBeenCalledExactlyOnceWith('old-token')
    } finally { await ctx.fiber.dispose() }
  })
})
