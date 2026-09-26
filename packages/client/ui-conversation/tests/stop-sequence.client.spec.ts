// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { StopSequence, type StopTarget } from '../src/client/stop-sequence.ts'

const id = (value: string): SessionId => value as SessionId
const sequences: StopSequence[] = []
function setup(interval = 500) {
  vi.useFakeTimers()
  const sequence = new StopSequence(interval, () => {})
  sequences.push(sequence)
  const cancel = vi.fn()
  const target: StopTarget = { sessionId: id('s1'), turn: 1, generation: {}, region: document.createElement('div'), cancel }
  return { sequence, target, cancel }
}
afterEach(() => {
  for (const sequence of sequences.splice(0)) sequence.reset()
  vi.useRealTimers()
})

describe('double Escape stop sequence', () => {
  it('requires two independent presses inside the configured interval and clears before cancelling', () => {
    const { sequence, target, cancel } = setup()
    expect(sequence.press(target)).toBe(false)
    vi.advanceTimersByTime(499)
    expect(sequence.press(target)).toBe(true)
    expect(cancel).toHaveBeenCalledOnce()
    expect(sequence.press(target)).toBe(false)
  })

  it('accepts the inclusive interval endpoint', () => {
    const { sequence, target } = setup()
    sequence.press(target)
    vi.advanceTimersByTime(500)
    expect(sequence.press(target)).toBe(true)
  })

  it('expires the first press and respects a deployment-configured interval', () => {
    const { sequence, target, cancel } = setup(100)
    sequence.press(target)
    vi.advanceTimersByTime(101)
    expect(sequence.press(target)).toBe(false)
    expect(cancel).not.toHaveBeenCalled()
    vi.advanceTimersByTime(99)
    expect(sequence.press(target)).toBe(true)
  })

  it.each(['session', 'turn', 'region', 'generation'] as const)('does not combine presses across %s changes', (field) => {
    const { sequence, target, cancel } = setup()
    sequence.press(target)
    const next: StopTarget = {
      ...target,
      ...(field === 'session' ? { sessionId: id('s2') }
        : field === 'turn' ? { turn: 2 }
          : field === 'generation' ? { generation: {} }
            : { region: document.createElement('div') }),
    }
    expect(sequence.press(next)).toBe(false)
    expect(cancel).not.toHaveBeenCalled()
    expect(sequence.press(next)).toBe(true)
  })

  it('discards a first press when local input, lifecycle or focus invalidates it', () => {
    const { sequence, target, cancel } = setup()
    sequence.press(target)
    sequence.reset()
    expect(vi.getTimerCount()).toBe(0)
    expect(sequence.press(target)).toBe(false)
    expect(cancel).not.toHaveBeenCalled()
  })
})
