/**
 * SubmitMachine behavior: enter routing, adjudication outcomes, the claimed
 * lifecycle and its integrity watch, settlement (commit-draft and claim
 * re-entry decisions), anti-backwash, and per-session isolation. Text-edit
 * semantics live in the editor (lexical-editor-core spec) — the machine only
 * observes drafts through event payloads.
 */
import { describe, expect, it } from 'vitest'
import type { CommandClaim } from '../src/client/contract/input.ts'
import type { InputEffect, SubmitAttempt } from '../src/client/contract/input.ts'
import { SubmitMachine } from '../src/client/input/machine.ts'
import { scanTextRefs } from '../src/client/input/decorations.ts'

function claimOf(name: string, hint?: string): CommandClaim {
  return {
    token: `/${name} `,
    ...(hint !== undefined ? { hint } : {}),
    submit: async () => ({ kind: 'success' }),
  }
}

function effectAt<T extends InputEffect['type']>(
  effects: readonly InputEffect[], index: number, type: T,
): Extract<InputEffect, { type: T }> {
  const e = effects[index]
  expect(e?.type).toBe(type)
  return e as Extract<InputEffect, { type: T }>
}

/** Drive plain → adjudicating and hand back the minted attempt. */
function enterAdjudicating(m: SubmitMachine, draft: string, mode: 'queue' | 'steer' = 'queue'): SubmitAttempt {
  const fx = m.dispatch({ type: 'enter', mode, draft })
  return effectAt(fx, 0, 'adjudicate').attempt
}

/** Drive plain → claimed → submitting and hand back attempt + claim. */
function enterSubmitting(m: SubmitMachine, name: string, args: string): { attempt: SubmitAttempt; claim: CommandClaim } {
  const claim = claimOf(name)
  m.dispatch({ type: 'claim', claim })
  const fx = m.dispatch({ type: 'enter', mode: 'queue', draft: claim.token + args })
  return { attempt: effectAt(fx, 0, 'begin-submit').attempt, claim }
}

function staleAttempt(): SubmitAttempt {
  return { seq: 9999, signal: new AbortController().signal, draftSnapshot: '', mode: 'queue' }
}

describe('submit-machine: plain × enter', () => {
  it('empty and whitespace-only drafts produce nothing', () => {
    const m = new SubmitMachine()
    expect(m.dispatch({ type: 'enter', mode: 'queue', draft: '' })).toEqual([])
    expect(m.dispatch({ type: 'enter', mode: 'queue', draft: '  \n ' })).toEqual([])
    expect(m.state.phase).toBe('plain')
  })

  it('non-command text falls to the default sink with the draft and mode', () => {
    const m = new SubmitMachine()
    const fx = m.dispatch({ type: 'enter', mode: 'queue', draft: 'hello' })
    const sink = effectAt(fx, 0, 'default-sink')
    expect(sink.draft).toBe('hello')
    expect(sink.mode).toBe('queue')
    expect(sink.attempt.draftSnapshot).toBe('hello')
    expect(effectAt(fx, 1, 'commit-draft').retainSuffixOf).toBe('hello')
    expect(m.state.phase).toBe('plain')
  })

  it('retains an explicit steer mode on the default sink effect', () => {
    const m = new SubmitMachine()
    const fx = m.dispatch({ type: 'enter', mode: 'steer', draft: 'go' })
    expect(effectAt(fx, 0, 'default-sink').mode).toBe('steer')
  })

  it('leading "/" enters adjudicating with a minted attempt carrying the draft snapshot', () => {
    const m = new SubmitMachine()
    const fx = m.dispatch({ type: 'enter', mode: 'queue', draft: '/goal write tests' })
    const adjudicate = effectAt(fx, 0, 'adjudicate')
    expect(adjudicate.draft).toBe('/goal write tests')
    expect(adjudicate.attempt.draftSnapshot).toBe('/goal write tests')
    expect(adjudicate.attempt.signal.aborted).toBe(false)
    expect(m.state.phase).toBe('adjudicating')
  })

  it('leading is judged after trim including newlines', () => {
    const m = new SubmitMachine()
    const fx = m.dispatch({ type: 'enter', mode: 'queue', draft: ' \n /goal x' })
    expect(effectAt(fx, 0, 'adjudicate').draft).toBe(' \n /goal x')
  })

  it('a non-whitespace prefix before "/" is not leading — default sink', () => {
    const m = new SubmitMachine()
    const fx = m.dispatch({ type: 'enter', mode: 'queue', draft: 'see /goal' })
    expect(effectAt(fx, 0, 'default-sink').draft).toBe('see /goal')
  })
})

describe('submit-machine: adjudication outcomes', () => {
  it('{claim} moves to submitting; args split on the first whitespace, newlines kept', () => {
    const m = new SubmitMachine()
    const attempt = enterAdjudicating(m, '/goal write x\nand y')
    const fx = m.dispatch({ type: 'adjudicated', attempt, outcome: { claim: claimOf('goal') } })
    const begin = effectAt(fx, 0, 'begin-submit')
    expect(begin.args).toBe('write x\nand y')
    expect(m.state.phase).toBe('submitting')
    expect(m.state.claim?.token).toBe('/goal ')
  })

  it('bare "/goal" claim yields empty args; leading whitespace snapshot yields trimmed args', () => {
    const m = new SubmitMachine()
    const attempt = enterAdjudicating(m, '/goal')
    const fx = m.dispatch({ type: 'adjudicated', attempt, outcome: { claim: claimOf('goal') } })
    expect(effectAt(fx, 0, 'begin-submit').args).toBe('')

    const m2 = new SubmitMachine()
    const attempt2 = enterAdjudicating(m2, '  /goal args')
    const fx2 = m2.dispatch({ type: 'adjudicated', attempt: attempt2, outcome: { claim: claimOf('goal') } })
    expect(effectAt(fx2, 0, 'begin-submit').args).toBe('args')
  })

  it('undefined outcome falls back to the default sink with the snapshot', () => {
    const m = new SubmitMachine()
    const attempt = enterAdjudicating(m, '/unknown thing', 'steer')
    const fx = m.dispatch({ type: 'adjudicated', attempt, outcome: undefined })
    const sink = effectAt(fx, 0, 'default-sink')
    expect(sink.draft).toBe('/unknown thing')
    expect(sink.mode).toBe('steer')
    expect(effectAt(fx, 1, 'commit-draft').retainSuffixOf).toBe('/unknown thing')
    expect(m.state.phase).toBe('plain')
  })

  it("'handled' lands plain with zero effects (popup shell path)", () => {
    const m = new SubmitMachine()
    const attempt = enterAdjudicating(m, '/model')
    expect(m.dispatch({ type: 'adjudicated', attempt, outcome: 'handled' })).toEqual([])
    expect(m.state.phase).toBe('plain')
  })

  it('adjudication failure notices and keeps plain — no silent downgrade', () => {
    const m = new SubmitMachine()
    const attempt = enterAdjudicating(m, '/goal x')
    const fx = m.dispatch({ type: 'adjudication-failed', attempt, message: 'warmup failed' })
    expect(effectAt(fx, 0, 'notice')).toMatchObject({ level: 'error', text: 'warmup failed' })
    expect(m.state.phase).toBe('plain')
  })

  it('enter is a no-op while adjudicating (pending lock)', () => {
    const m = new SubmitMachine()
    enterAdjudicating(m, '/goal x')
    expect(m.dispatch({ type: 'enter', mode: 'queue', draft: '/goal x' })).toEqual([])
    expect(m.state.phase).toBe('adjudicating')
  })

  it('a stale attempt on adjudicated/adjudication-failed is dropped: same state, zero effects', () => {
    const m = new SubmitMachine()
    enterAdjudicating(m, '/goal x')
    expect(m.dispatch({ type: 'adjudicated', attempt: staleAttempt(), outcome: undefined })).toEqual([])
    expect(m.dispatch({ type: 'adjudication-failed', attempt: staleAttempt(), message: 'x' })).toEqual([])
    expect(m.state.phase).toBe('adjudicating')
  })

  it('an adjudicated result arriving after release is dropped (anti-backwash)', () => {
    const m = new SubmitMachine()
    const attempt = enterAdjudicating(m, '/goal x')
    m.dispatch({ type: 'release' })
    expect(attempt.signal.aborted).toBe(true)
    expect(m.dispatch({ type: 'adjudicated', attempt, outcome: { claim: claimOf('goal') } })).toEqual([])
    expect(m.state.phase).toBe('plain')
  })
})

describe('submit-machine: claimed lifecycle', () => {
  it('the claim event enters claimed and snapshots hint and images bits', () => {
    const m = new SubmitMachine()
    m.dispatch({ type: 'claim', claim: { ...claimOf('goal', 'set a goal'), attachments: true } })
    expect(m.state.phase).toBe('claimed')
    expect(m.state.claim).toMatchObject({ token: '/goal ', hint: 'set a goal', attachments: true })
  })

  it('claimed overwrites in place — no stack', () => {
    const m = new SubmitMachine()
    m.dispatch({ type: 'claim', claim: claimOf('goal') })
    m.dispatch({ type: 'claim', claim: claimOf('plan') })
    expect(m.state.claim?.token).toBe('/plan ')
    expect(m.state.phase).toBe('claimed')
  })

  it('submitting rejects the claim event (lock)', () => {
    const m = new SubmitMachine()
    enterSubmitting(m, 'goal', 'x')
    m.dispatch({ type: 'claim', claim: claimOf('plan') })
    expect(m.state.claim?.token).toBe('/goal ')
    expect(m.state.phase).toBe('submitting')
  })

  it('breaking startsWith(token) auto-releases back to plain', () => {
    const m = new SubmitMachine()
    m.dispatch({ type: 'claim', claim: claimOf('goal') })
    m.dispatch({ type: 'draft-changed', draft: '/goal args fine' })
    expect(m.state.phase).toBe('claimed')
    m.dispatch({ type: 'draft-changed', draft: '/goa' })
    expect(m.state.phase).toBe('plain')
    expect(m.state.claim).toBeUndefined()
  })

  it('explicit release returns to plain when nothing is in flight', () => {
    const m = new SubmitMachine()
    m.dispatch({ type: 'claim', claim: claimOf('goal') })
    m.dispatch({ type: 'release' })
    expect(m.state.phase).toBe('plain')
    expect(m.state.claim).toBeUndefined()
  })

  it('enter begins the submit transaction: args = draft minus token, multi-line legal', () => {
    const m = new SubmitMachine()
    m.dispatch({ type: 'claim', claim: claimOf('goal') })
    const fx = m.dispatch({ type: 'enter', mode: 'queue', draft: '/goal line one\nline two' })
    expect(effectAt(fx, 0, 'begin-submit').args).toBe('line one\nline two')
  })
})

describe('submit-machine: submitting transaction', () => {
  it('enter and claim are locked while submitting; draft-changed is recorded without leaving submitting', () => {
    const m = new SubmitMachine()
    enterSubmitting(m, 'goal', 'x')
    expect(m.dispatch({ type: 'enter', mode: 'queue', draft: '/goal x' })).toEqual([])
    m.dispatch({ type: 'draft-changed', draft: 'typed during flight' })
    expect(m.state.phase).toBe('submitting')
  })

  it('commit emits commit-draft with the snapshot, releases the claim, and relays the outcome text', () => {
    const m = new SubmitMachine()
    const { attempt } = enterSubmitting(m, 'goal', 'x')
    const fx = m.dispatch({
      type: 'submit-settled', attempt, ok: true, draft: '/goal x',
      outcome: { kind: 'success', text: 'goal saved' },
    })
    expect(effectAt(fx, 0, 'commit-draft').retainSuffixOf).toBe('/goal x')
    expect(effectAt(fx, 1, 'notice')).toMatchObject({ level: 'info', text: 'goal saved' })
    expect(m.state.phase).toBe('plain')
    expect(m.state.claim).toBeUndefined()
  })

  it('an error-kind outcome text relays as an error notice on success=false settles', () => {
    const m = new SubmitMachine()
    const { attempt } = enterSubmitting(m, 'goal', 'x')
    const fx = m.dispatch({
      type: 'submit-settled', attempt, ok: false, draft: 'deviated',
      outcome: { kind: 'error', text: 'rejected' },
    })
    expect(effectAt(fx, 0, 'notice')).toMatchObject({ level: 'error', text: 'rejected' })
    expect(m.state.phase).toBe('plain')
  })

  it('rollback with an undeviated draft keeps the claim and re-enters claimed', () => {
    const m = new SubmitMachine()
    const { attempt } = enterSubmitting(m, 'goal', 'x')
    m.dispatch({ type: 'submit-settled', attempt, ok: false, draft: '/goal x', message: 'transport' })
    expect(m.state.phase).toBe('claimed')
    expect(m.state.claim?.token).toBe('/goal ')
  })

  it('rollback with a deviated draft only notices — the newer input wins', () => {
    const m = new SubmitMachine()
    const { attempt } = enterSubmitting(m, 'goal', 'x')
    const fx = m.dispatch({ type: 'submit-settled', attempt, ok: false, draft: 'rewritten', message: 'transport' })
    expect(effectAt(fx, 0, 'notice')).toMatchObject({ level: 'error', text: 'transport' })
    expect(m.state.phase).toBe('plain')
    expect(m.state.claim).toBeUndefined()
  })

  it('enter-path rollback cannot re-enter claimed when the snapshot never carried the bare token prefix', () => {
    const m = new SubmitMachine()
    const attempt = enterAdjudicating(m, '  /goal x')
    m.dispatch({ type: 'adjudicated', attempt, outcome: { claim: claimOf('goal') } })
    m.dispatch({ type: 'submit-settled', attempt, ok: false, draft: '  /goal x', message: 'nope' })
    // The snapshot carries leading whitespace the token never had: plain, claim cleared.
    expect(m.state.phase).toBe('plain')
    expect(m.state.claim).toBeUndefined()
  })

  it('a stale settle after rollback + resubmit is dropped (anti-backwash)', () => {
    const m = new SubmitMachine()
    const { attempt: first } = enterSubmitting(m, 'goal', 'x')
    m.dispatch({ type: 'submit-settled', attempt: first, ok: false, draft: '/goal x', message: 'try again' })
    const fx = m.dispatch({ type: 'enter', mode: 'queue', draft: '/goal x' })
    const second = effectAt(fx, 0, 'begin-submit').attempt
    expect(m.dispatch({ type: 'submit-settled', attempt: first, ok: true, draft: '/goal x' })).toEqual([])
    expect(m.state.phase).toBe('submitting')
    m.dispatch({ type: 'submit-settled', attempt: second, ok: true, draft: '/goal x' })
    expect(m.state.phase).toBe('plain')
  })

  it('release mid-flight aborts the attempt and later settles are dropped', () => {
    const m = new SubmitMachine()
    const { attempt } = enterSubmitting(m, 'goal', 'x')
    m.dispatch({ type: 'release' })
    expect(attempt.signal.aborted).toBe(true)
    expect(m.dispatch({ type: 'submit-settled', attempt, ok: true, draft: '' })).toEqual([])
    expect(m.state.phase).toBe('plain')
  })

  it('send-committed clears unconditionally (image-only sends have no draft to retain)', () => {
    const m = new SubmitMachine()
    const fx = m.dispatch({ type: 'send-committed' })
    expect(effectAt(fx, 0, 'commit-draft').retainSuffixOf).toBeNull()
    const busy = new SubmitMachine()
    enterSubmitting(busy, 'goal', 'x')
    expect(busy.dispatch({ type: 'send-committed' })).toEqual([])
  })
})

describe('submit-machine: per-session isolation', () => {
  it('one instance per session: A submitting never locks B; settles land on their own instance', () => {
    const a = new SubmitMachine()
    const b = new SubmitMachine()
    const { attempt } = enterSubmitting(a, 'goal', 'x')
    const fx = b.dispatch({ type: 'enter', mode: 'queue', draft: 'hello' })
    expect(effectAt(fx, 0, 'default-sink').draft).toBe('hello')
    a.dispatch({ type: 'submit-settled', attempt, ok: true, draft: '/goal x' })
    expect(a.state.phase).toBe('plain')
    expect(b.state.phase).toBe('plain')
  })
})

describe('decorations: scanTextRefs', () => {
  const lexicon: ReadonlyMap<'/' | '@', readonly string[]> = new Map([
    ['/', ['commit-helper', 'goal'] as readonly string[]],
    ['@', ['research'] as readonly string[]],
  ])

  it('matches lexicon tokens at line start and after whitespace, in draft order', () => {
    const out = scanTextRefs('/goal then @research and /commit-helper', lexicon)
    expect(out.map(r => [r.start, r.end, r.trigger])).toEqual([
      [0, 5, '/'], [11, 20, '@'], [25, 39, '/'],
    ])
  })

  it('a cold (empty) lexicon scans nothing lexicon-based', () => {
    expect(scanTextRefs('/goal x', new Map())).toEqual([])
  })

  it('recognizes directory paths independently of the dynamic lexicon', () => {
    const out = scanTextRefs('see @src/x/ now', new Map())
    expect(out).toEqual([{ start: 4, end: 11, trigger: '@' }])
  })

  it('names off the lexicon do not match; triggers are routed per lexicon list', () => {
    expect(scanTextRefs('/research @goal', lexicon)).toEqual([])
  })

  it('a "/" token continued by a path never matches, even when the name is on the lexicon', () => {
    expect(scanTextRefs('/goal/x /goal/ /goal.md', lexicon)).toEqual([])
  })

  it('a "/" token glued to punctuation is not a reference: the host gesture is whitespace-bounded', () => {
    expect(scanTextRefs('/goal。 then /goal, now', lexicon)).toEqual([])
  })

  it('word boundary: a trigger glued to text never matches', () => {
    expect(scanTextRefs('x/goal y@research', lexicon)).toEqual([])
  })

  it('tokens never cross a newline; a token straight after one matches', () => {
    const out = scanTextRefs('a\n/goal', lexicon)
    expect(out).toEqual([{ start: 2, end: 7, trigger: '/' }])
  })
})
