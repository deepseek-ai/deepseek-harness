/** Recorded-session probe of catalog and locally overridden request images. */

import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { isAttachmentError } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'

export const name = 'snapshot-pi-image-limits'
export const inject = ['tools', 'llm', 'attachments']

/**
 * Expose encoded request dimensions through the real attachment provider.
 * @param ctx - Loader context containing both configured pi routes.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(defineContentToolFixture({
    name: 'snapshot_image_limits',
    description: 'Report the source and request image sizes for the catalog and overridden routes.',
    parameters: {},
    async execute() {
      const source = await ctx.attachments.saveImage({ data: await readFile('tall.png'), mediaType: 'image/png' })
      const results = []
      for (const [provider, model] of [['anthropic', 'claude-sonnet-4-5'], ['image-override', 'vision']] as const) {
        const target = ctx.llm.imageRequestTarget(provider, model, source)
        const encoded = await ctx.attachments.readImageRequest(source, target)
        results.push({ provider, target, encoded: {
          width: encoded.width, height: encoded.height, withinLimit: encoded.bytes <= target.maxImageBytes,
        } })
      }
      let impossibleBudgetError = ''
      try {
        await ctx.attachments.readImageRequest(source, { width: 1, height: 1, maxImageBytes: 1, imageTargetBytes: 1 })
      } catch (error) {
        if (!isAttachmentError(error) || error.code !== 'IMAGE_REQUEST_TOO_LARGE') throw error
        impossibleBudgetError = error.code
      }
      return [{ type: 'text', text: JSON.stringify({ impossibleBudgetError, source: { width: source.width, height: source.height }, results }) }]
    },
  })))
}
