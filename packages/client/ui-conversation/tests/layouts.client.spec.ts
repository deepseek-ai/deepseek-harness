import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it } from 'vitest'
import { ConversationLayouts } from '../src/client/conversation/layouts.ts'

const S1 = 's1' as SessionId
const S2 = 's2' as SessionId

describe('ConversationLayouts', () => {
  it('publishes the measured gutter and whether the body shows the Session, while Chat is active', () => {
    const layouts = new ConversationLayouts(() => undefined)
    const source = layouts.source(S1)
    expect(source.getSnapshot()).toEqual({ endGutter: 0, shown: false })
    layouts.measure(S1, 400)
    // Before a View activates, nothing follows the transcript column.
    expect(source.getSnapshot()).toEqual({ endGutter: 0, shown: true })
    layouts.activate(S1, true)
    expect(source.getSnapshot()).toEqual({ endGutter: 400, shown: true })
    layouts.measure(S1, -5)
    expect(source.getSnapshot()).toEqual({ endGutter: 0, shown: true })
    layouts.measure(S1, 360)
    layouts.activate(S1, false)
    expect(source.getSnapshot()).toEqual({ endGutter: 0, shown: true })
    layouts.activate(S1, true)
    layouts.measure(S1, null)
    expect(source.getSnapshot()).toEqual({ endGutter: 0, shown: false })
    expect(layouts.source(S2).getSnapshot()).toEqual({ endGutter: 0, shown: false })
  })

  it('keeps the snapshot identity until a fact changes and notifies only on changes', () => {
    const layouts = new ConversationLayouts(() => undefined)
    const source = layouts.source(S1)
    layouts.activate(S1, true)
    layouts.measure(S1, 400)
    const first = source.getSnapshot()
    let notified = 0
    const off = source.subscribe(() => { notified += 1 })
    layouts.measure(S1, 400)
    layouts.activate(S1, true)
    expect(source.getSnapshot()).toBe(first)
    expect(notified).toBe(0)
    layouts.measure(S1, 380)
    expect(notified).toBe(1)
    off()
  })

  it('drops a Session layout when its scope is released, and every layout on dispose', async () => {
    const root = new Context()
    const one = root.plugin(() => {})
    const two = root.plugin(() => {})
    await Promise.all([one, two])
    const scopes = new Map([[S1, one], [S2, two]])
    const layouts = new ConversationLayouts(sessionId => scopes.get(sessionId)?.ctx)
    const first = layouts.source(S1)
    expect(layouts.source(S1)).toBe(first)
    layouts.activate(S1, true)
    layouts.measure(S1, 400)
    const seen: unknown[] = []
    first.subscribe(() => { seen.push(first.getSnapshot()) })
    // A released Session no longer resolves a binding scope, and its readers see it hidden.
    await scopes.get(S1)?.dispose()
    scopes.delete(S1)
    expect(seen).toEqual([{ endGutter: 0, shown: false }])
    // The body's final report after the release recreates nothing.
    layouts.measure(S1, null)
    expect(layouts.source(S1)).not.toBe(first)
    expect(layouts.source(S1).getSnapshot()).toEqual({ endGutter: 0, shown: false })
    const second = layouts.source(S2)
    layouts.dispose()
    expect(layouts.source(S2)).not.toBe(second)
    // A Session without a scope keeps its layout until dispose.
    const unscoped = layouts.source('s3' as SessionId)
    expect(layouts.source('s3' as SessionId)).toBe(unscoped)
  })
})
