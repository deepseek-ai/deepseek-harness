/**
 * Tests for the spill Service Definition: a minimal concrete subclass registers as
 * `ctx.spillStore`, a second load throws (duplicate service), and disposal
 * releases the service. The storage behavior is the implementation's concern
 * (`@deepseek-ai/dsh-spill-local`); here we only pin the seam contract.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SpillLocator, SpillStore } from '@deepseek-ai/dsh-spill'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'

/** Minimal concrete backend: records the last request, returns a fixed ref. */
class StubStore extends SpillStore {
  last: SaveTextSpill | undefined

  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    this.last = input
    return {
      locator: SpillLocator(`/stub/${input.suggestedName}`),
      bytes: Buffer.byteLength(input.content, 'utf8'),
      retrievalHint: 'Use the stub reader.',
    }
  }
}

function request(content: string): SaveTextSpill {
  return {
    owner: { sessionId: SessionId('s1') },
    source: { kind: 'tool', toolName: 'web_fetch', callId: ToolCallId('c1'), label: 'result' },
    suggestedName: 'web_fetch.txt',
    content,
  }
}

describe('spill seam', () => {
  it('registers as ctx.spillStore and saves text', async () => {
    const ctx = new Context()
    await ctx.plugin(StubStore)
    const ref = await ctx.spillStore.saveText(request('hello'))
    expect(ref).toEqual({ locator: '/stub/web_fetch.txt', bytes: 5, retrievalHint: 'Use the stub reader.' })
    expect((ctx.spillStore as StubStore).last?.content).toBe('hello')
  })

  it('rejects a second implementation (one per context)', async () => {
    const ctx = new Context()
    await ctx.plugin(StubStore)
    await expect(ctx.plugin(StubStore)).rejects.toThrow()
  })

  it('releases the service on disposal', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(StubStore)
    expect(ctx.spillStore).toBeInstanceOf(StubStore)
    await fiber.dispose()
    expect((ctx as Context & { spillStore?: unknown }).spillStore).toBeUndefined()
  })
})
