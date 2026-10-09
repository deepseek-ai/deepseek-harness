import { describe, expect, it } from 'vitest'
import { parseHookOutput } from '@deepseek-ai/dsh-hook-protocol'

describe('parseHookOutput — exit code semantics', () => {
  it('exit 0 with no stdout is a neutral success', () => {
    const out = parseHookOutput(0, '', '')
    expect(out.exitCode).toBe(0)
    expect(out.decision).toBeUndefined()
    expect(out.continue).toBeUndefined()
  })

  it('exit 2 is a blocking error: stderr becomes the block decision + reason', () => {
    const out = parseHookOutput(2, '', 'this command is not allowed')
    expect(out.decision).toBe('block')
    expect(out.reason).toBe('this command is not allowed')
    expect(out.stderr).toBe('this command is not allowed')
  })

  it('exit 2 with empty stderr still blocks, with no reason', () => {
    const out = parseHookOutput(2, '', '   ')
    expect(out.decision).toBe('block')
    expect(out.reason).toBeUndefined()
  })

  it('other non-zero exit is a non-blocking error (no decision, stderr recorded)', () => {
    const out = parseHookOutput(1, '', 'some warning')
    expect(out.decision).toBeUndefined()
    expect(out.exitCode).toBe(1)
    expect(out.stderr).toBe('some warning')
  })

  it('undefined exit (could not run) carries no decision', () => {
    const out = parseHookOutput(undefined, '', 'spawn failed: ENOENT')
    expect(out.exitCode).toBeUndefined()
    expect(out.decision).toBeUndefined()
    expect(out.stderr).toBe('spawn failed: ENOENT')
  })
})

describe('parseHookOutput — structured stdout (exit 0 only)', () => {
  it('parses top-level continue/stopReason/systemMessage', () => {
    const out = parseHookOutput(0, JSON.stringify({
      continue: false, stopReason: 'budget exceeded', systemMessage: 'heads up',
    }), '')
    expect(out.continue).toBe(false)
    expect(out.stopReason).toBe('budget exceeded')
    expect(out.systemMessage).toBe('heads up')
  })

  it('parses legacy top-level decision + reason (approve/block ONLY)', () => {
    expect(parseHookOutput(0, JSON.stringify({ decision: 'block', reason: 'nope' }), '').decision).toBe('block')
    expect(parseHookOutput(0, JSON.stringify({ decision: 'approve' }), '').decision).toBe('approve')
  })

  it('a top-level decision of allow/deny/ask is INVALID and ignored (reserved for permissionDecision)', () => {
    // Both reference schemas restrict the legacy top-level `decision` to
    // approve/block; allow/deny/ask must come from hookSpecificOutput.permissionDecision.
    expect(parseHookOutput(0, JSON.stringify({ decision: 'deny' }), '').decision).toBeUndefined()
    expect(parseHookOutput(0, JSON.stringify({ decision: 'allow' }), '').decision).toBeUndefined()
    expect(parseHookOutput(0, JSON.stringify({ decision: 'ask' }), '').decision).toBeUndefined()
  })

  it('captures hookEventName from hookSpecificOutput (the discriminator a bridge validates)', () => {
    const out = parseHookOutput(0, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } }), '')
    expect(out.hookEventName).toBe('PreToolUse')
    expect(out.decision).toBe('deny')
  })

  it('hookSpecificOutput.permissionDecision OVERRIDES the legacy top-level decision', () => {
    const out = parseHookOutput(0, JSON.stringify({
      decision: 'approve',
      hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'denied by policy' },
    }), '')
    expect(out.decision).toBe('deny')
    expect(out.reason).toBe('denied by policy')
  })

  it('parses allow/ask permissionDecision (the bridge decides whether to honor)', () => {
    expect(parseHookOutput(0, JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }), '').decision).toBe('allow')
    expect(parseHookOutput(0, JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask' } }), '').decision).toBe('ask')
  })

  it('parses additionalContext and updatedInput from hookSpecificOutput', () => {
    const out = parseHookOutput(0, JSON.stringify({
      hookSpecificOutput: { additionalContext: 'remember X', updatedInput: { command: 'safe' } },
    }), '')
    expect(out.additionalContext).toBe('remember X')
    expect(out.updatedInput).toEqual({ command: 'safe' })
  })

  it('an unknown decision string is ignored (not coerced)', () => {
    expect(parseHookOutput(0, JSON.stringify({ decision: 'maybe' }), '').decision).toBeUndefined()
  })

  it('DISCARDS a hookSpecificOutput block whose hookEventName mismatches the firing event', () => {
    // A PreToolUse block emitted on a Stop hook is malformed — its event-scoped
    // fields must not take effect (a stray PreToolUse deny must not deny the Stop).
    const out = parseHookOutput(0, JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no', additionalContext: 'x', updatedInput: { command: 'y' } },
    }), '', 'Stop')
    expect(out.hookEventName).toBe('PreToolUse') // still recorded for the log
    expect(out.decision).toBeUndefined() // event-scoped fields discarded
    expect(out.reason).toBeUndefined()
    expect(out.additionalContext).toBeUndefined()
    expect(out.updatedInput).toBeUndefined()
  })

  it('APPLIES a hookSpecificOutput block whose hookEventName matches the firing event', () => {
    const out = parseHookOutput(0, JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', additionalContext: 'x' },
    }), '', 'PreToolUse')
    expect(out.decision).toBe('deny')
    expect(out.additionalContext).toBe('x')
  })

  it('applies the block when expectedEventName is omitted (opt-out) even if it names an event', () => {
    const out = parseHookOutput(0, JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    }), '')
    expect(out.decision).toBe('deny')
  })

  it('DISCARDS a block with NO hookEventName when a firing event is expected', () => {
    // Under the keyed schema a missing discriminator is as malformed as a
    // mismatched one: a discriminator-less block must not apply its event-scoped
    // permission fields to whatever event happens to be firing.
    const out = parseHookOutput(0, JSON.stringify({
      hookSpecificOutput: { permissionDecision: 'deny', additionalContext: 'x' },
    }), '', 'Stop')
    expect(out.hookEventName).toBeUndefined() // none to record
    expect(out.decision).toBeUndefined() // event-scoped fields discarded
    expect(out.additionalContext).toBeUndefined()
  })

  it('applies a discriminator-less block when expectedEventName is omitted (opt-out)', () => {
    // With no firing event to validate against, the block applies as-is.
    const out = parseHookOutput(0, JSON.stringify({
      hookSpecificOutput: { permissionDecision: 'deny' },
    }), '')
    expect(out.decision).toBe('deny')
  })

  it('a mismatched block does NOT discard the event-agnostic top-level decision/continue', () => {
    // Only the per-event block is scoped; top-level fields are event-agnostic.
    const out = parseHookOutput(0, JSON.stringify({
      decision: 'block', reason: 'top', continue: false, stopReason: 'halt',
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    }), '', 'Stop')
    expect(out.decision).toBe('block') // top-level survives; the allow block was discarded
    expect(out.reason).toBe('top')
    expect(out.continue).toBe(false)
    expect(out.stopReason).toBe('halt')
  })

  it('malformed JSON on a clean exit is lenient (no structured output, no throw)', () => {
    const out = parseHookOutput(0, '{ not valid json', '')
    expect(out.decision).toBeUndefined()
    expect(out.continue).toBeUndefined()
  })

  it('non-object stdout (plain text) on exit 0 is left for the bridge (no JSON attempt)', () => {
    const out = parseHookOutput(0, 'just some text output', '')
    expect(out.decision).toBeUndefined()
    expect(out.continue).toBeUndefined()
    // The raw stdout is preserved verbatim so the bridge can render/use it
    // (CC output; Codex additionalContext) — trimmed.
    expect(out.stdout).toBe('just some text output')
  })

  it('preserves raw stdout (trimmed) alongside parsed structured fields', () => {
    const json = JSON.stringify({ decision: 'block' })
    const out = parseHookOutput(0, `  ${json}  \n`, '')
    expect(out.stdout).toBe(json)
    expect(out.decision).toBe('block')
  })

  it('stdout is empty string when the hook emits none', () => {
    expect(parseHookOutput(0, '', '').stdout).toBe('')
  })

  it('a JSON array stdout parses but yields no fields (not an object)', () => {
    // Starts with '{'? No — '[' — so it is not even attempted. Neutral.
    const out = parseHookOutput(0, '[1,2,3]', '')
    expect(out.decision).toBeUndefined()
  })

  it('structured stdout is IGNORED on a blocking (exit 2) run — stderr is authoritative', () => {
    const out = parseHookOutput(2, JSON.stringify({ decision: 'approve' }), 'blocked')
    // exit 2 forces block regardless of what stdout claims
    expect(out.decision).toBe('block')
    expect(out.reason).toBe('blocked')
  })
})
