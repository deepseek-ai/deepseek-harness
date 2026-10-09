/** Opt-in native-fetch probes of the actual anonymous browser endpoints. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import Translator from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

async function translator() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Translator, Translator.Config({ timeoutMs: 30_000 }))
  return ctx.translator
}

describe.skipIf(process.env.DSH_TRANSLATION_LIVE !== '1')('anonymous translation real endpoints', () => {
  it('uses default Bing with automatic source detection and a Simplified Chinese locale', async () => {
    const service = await translator()
    const spec = service.resolve({ text: 'Hello world.', targetLanguage: 'zh-CN' })
    expect(spec.provider).toBe('bing')
    expect(spec.sourceLanguage).toBe('auto')
    expect(await service.translate(spec)).toContain('世界')
  })

  it('uses default Bing with an explicit English source and a Traditional Chinese locale', async () => {
    const service = await translator()
    const spec = service.resolve({ text: 'The computer processes data.', targetLanguage: 'zh-TW', sourceLanguage: 'en' })
    expect(spec.provider).toBe('bing')
    expect(await service.translate(spec)).toMatch(/電腦|計算機/u)
  })

  it.each(['zh-Hans', 'zh-Hant'])('uses explicit Google with Chinese tag %s', async (targetLanguage) => {
    const service = await translator()
    const spec = service.resolve({ text: 'The computer processes data.', targetLanguage, sourceLanguage: 'en', provider: 'google' })
    const result = await service.translate(spec)
    expect(result).toMatch(targetLanguage === 'zh-Hans' ? /电脑|计算机/u : /電腦|計算機/u)
  })

  it('translates 4000 CJK characters through the Google form endpoint', async () => {
    const service = await translator()
    const text = '你好世界。'.repeat(800)
    expect(text.length).toBe(service.maxTextChars)
    const result = await service.translate(service.resolve({ text, targetLanguage: 'en', sourceLanguage: 'zh-CN', provider: 'google' }))
    expect(result).toMatch(/world/i)
  })
})
