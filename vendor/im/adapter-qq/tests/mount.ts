/** Shared offline mount of the QQ adapter for the mode specs. */
import { afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Http from '@deepseek-ai/cordis-plugin-http'
import { Satori, type Target } from '@deepseek-ai/cordis-plugin-im-core'
import QQBot, { Config, type QQConfig } from '@deepseek-ai/cordis-plugin-im-adapter-qq'
import * as Markdown from '@deepseek-ai/cordis-plugin-im-markdown'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

export async function mountQQ(input: Partial<QQConfig> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Http)
  await ctx.plugin(Satori)
  await ctx.plugin(Markdown)
  ctx.on('http/fetch', () => {
    throw new Error('unexpected network request')
  })
  const config: QQConfig = Config({ appId: '102106848', secret: 'secret', transport: 'none', ...input } as QQConfig)
  await ctx.plugin(QQBot, config)
  const bot = ctx.bots[0] as QQBot
  // Offline uploads (renderCorpus prepares for real): the file_info is derived from the resource.
  bot.upload = async ref => ({ key: `file_info:${ref.kind}:${ref.src}` })
  return bot
}

export const group: Target = { chat: { id: 'group:FBB1D91204242AAB8B61A0179A6245B0', type: 'group' } }
export const direct: Target = { chat: { id: 'user:DD8246C68EC19CAF8D2AA76941180EA4', type: 'direct' } }
export const goldens = new URL('./goldens', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
