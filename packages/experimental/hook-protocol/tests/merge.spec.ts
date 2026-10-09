import { describe, expect, it } from 'vitest'
import { mergeHookOutputs } from '@deepseek-ai/dsh-hook-protocol'
import type { HookOutput } from '@deepseek-ai/dsh-hook-protocol'

function out(over: Partial<HookOutput> = {}): HookOutput {
  return { exitCode: 0, stderr: '', stdout: '', ...over }
}

describe('mergeHookOutputs — permission precedence deny > ask > allow', () => {
  it('empty list yields a neutral outcome', () => {
    const m = mergeHookOutputs([])
    expect(m.decision).toBe('none')
    expect(m.stop).toBe(false)
    expect(m.additionalContext).toEqual([])
    expect(m.systemMessages).toEqual([])
  })

  it('a single allow yields allow', () => {
    expect(mergeHookOutputs([out({ decision: 'allow' })]).decision).toBe('allow')
    expect(mergeHookOutputs([out({ decision: 'approve' })]).decision).toBe('allow')
  })

  it('deny beats ask beats allow regardless of order', () => {
    expect(mergeHookOutputs([out({ decision: 'allow' }), out({ decision: 'ask' })]).decision).toBe('ask')
    expect(mergeHookOutputs([out({ decision: 'ask' }), out({ decision: 'deny' })]).decision).toBe('deny')
    expect(mergeHookOutputs([out({ decision: 'deny' }), out({ decision: 'allow' })]).decision).toBe('deny')
    // block folds to deny
    expect(mergeHookOutputs([out({ decision: 'allow' }), out({ decision: 'block' })]).decision).toBe('deny')
  })

  it('no decision anywhere yields none', () => {
    expect(mergeHookOutputs([out(), out()]).decision).toBe('none')
  })
})

describe('mergeHookOutputs — reasons, stop, context, systemMessages accumulate', () => {
  it('joins block/deny reasons with a blank line (only from blocking hooks)', () => {
    const m = mergeHookOutputs([
      out({ decision: 'deny', reason: 'first objection' }),
      out({ decision: 'allow', reason: 'this allow reason is NOT collected' }),
      out({ decision: 'block', reason: 'second objection' }),
    ])
    expect(m.reason).toBe('first objection\n\nsecond objection')
  })

  it('no reason when nothing blocked', () => {
    expect(mergeHookOutputs([out({ decision: 'allow' })]).reason).toBeUndefined()
  })

  it('surfaces the reason of the WINNING decision: an ask-winning outcome shows the ask reason', () => {
    const m = mergeHookOutputs([
      out({ decision: 'allow', reason: 'allow reason — not surfaced' }),
      out({ decision: 'ask', reason: 'needs approval' }),
    ])
    expect(m.decision).toBe('ask')
    expect(m.reason).toBe('needs approval')
  })

  it('when deny wins over ask, the ask reasons are dropped (only the winning rank\'s reasons)', () => {
    const m = mergeHookOutputs([
      out({ decision: 'ask', reason: 'ask reason — not surfaced once deny wins' }),
      out({ decision: 'deny', reason: 'the real objection' }),
    ])
    expect(m.decision).toBe('deny')
    expect(m.reason).toBe('the real objection')
  })

  it('stop is sticky on the first continue:false, capturing its stopReason', () => {
    const m = mergeHookOutputs([
      out({ continue: true }),
      out({ continue: false, stopReason: 'halt now' }),
      out({ continue: false, stopReason: 'second halt — ignored' }),
    ])
    expect(m.stop).toBe(true)
    expect(m.stopReason).toBe('halt now')
  })

  it('no stop when every hook continues', () => {
    const m = mergeHookOutputs([out({ continue: true }), out()])
    expect(m.stop).toBe(false)
    expect(m.stopReason).toBeUndefined()
  })

  it('a continue:false with no stopReason stops with an undefined reason', () => {
    const m = mergeHookOutputs([out({ continue: false })])
    expect(m.stop).toBe(true)
    expect(m.stopReason).toBeUndefined()
  })

  it('collects additionalContext and systemMessages in hook order, skipping empties', () => {
    const m = mergeHookOutputs([
      out({ additionalContext: 'ctx-A', systemMessage: 'warn-A' }),
      out({ additionalContext: '', systemMessage: '' }), // empties skipped
      out({ additionalContext: 'ctx-B' }),
      out({ systemMessage: 'warn-B' }),
    ])
    expect(m.additionalContext).toEqual(['ctx-A', 'ctx-B'])
    expect(m.systemMessages).toEqual(['warn-A', 'warn-B'])
  })
})
