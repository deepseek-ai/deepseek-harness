/** Reference reads fall back to the launch environment only when no credentials service is mounted. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { credentialRef, credentialRefConfigured, resolveCredentialRef } from '../src/index.ts'
import { MemoryCredentials } from './memory.ts'

const ref = credentialRef('TEST_PROVIDER_KEY')

function context(value?: string): Context {
  const ctx = new Context()
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
    { source: 'process', values: value === undefined ? {} : { [ref]: value } },
  ]))
  return ctx
}

describe('reference reads without a credentials service', () => {
  it.each([undefined, '', 'ambient-key'])('read the launch environment, treating empty as absent: %j', async (value) => {
    const ctx = context(value)
    try {
      await expect(resolveCredentialRef(ctx, ref)).resolves.toBe(value ? value : undefined)
      await expect(credentialRefConfigured(ctx, ref)).resolves.toBe(Boolean(value))
    } finally { await ctx.fiber.dispose() }
  })
})

describe('reference reads with a credentials service', () => {
  it('treat the service as authoritative, including its absence of a value', async () => {
    const ctx = context('ambient-key')
    const resolve = vi.fn(async () => undefined)
    const describeRef = vi.fn(async () => ({ configured: false, writable: true }))
    ctx.provide('credentials', { resolve, describe: describeRef } as never)
    try {
      await expect(credentialRefConfigured(ctx, ref)).resolves.toBe(false)
      expect(resolve).not.toHaveBeenCalled()
      await expect(resolveCredentialRef(ctx, ref)).resolves.toBeUndefined()
      expect(resolve).toHaveBeenCalledExactlyOnceWith(ref)
    } finally { await ctx.fiber.dispose() }
  })

  it('return the stored value verbatim on every read', async () => {
    const ctx = context('ambient-key')
    await ctx.plugin(MemoryCredentials, { [ref]: ' stored-key ' })
    try {
      await expect(resolveCredentialRef(ctx, ref)).resolves.toBe(' stored-key ')
      await expect(credentialRefConfigured(ctx, ref)).resolves.toBe(true)
    } finally { await ctx.fiber.dispose() }
  })
})
