/** Account Host configuration: live questionnaire options and the hidden generated form. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { apply, Config } from '../src/index.ts'

it('declares live questionnaire options with HTTPS destinations only', () => {
  const config = Config({ contactSource: 'harness' })
  expect(config.contactSource.get()).toBe('harness')
  expect(new URL(config.contactFormUrl.get()).origin).toBe('https://trtgsjkv6r.feishu.cn')
  expect(Config({}).contactSource.get()).toBe('')
  expect(() => Config({ contactFormUrl: 'javascript:alert(1)' })).toThrow()
})

it('hides the generated account form and releases its policy on disposal', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const release = vi.fn()
  const configure = vi.fn(() => release)
  ctx.provide('settings', { configure } as never)
  const fiber = await ctx.plugin({ Config, apply })
  await ctx.fiber.await()
  expect(configure).toHaveBeenCalledWith({ auto: false }, fiber)
  await fiber.dispose()
  expect(release).toHaveBeenCalledOnce()
})
