/**
 * SubmitMachine: the pure per-session submit-plane state machine.
 * Events in, effects out; zero React / DOM / cordis. Package-private; the
 * SessionInput shell owns editor state and executes the returned effects.
 *
 * Claimed commands and ordinary messages occupy the one frozen in-flight
 * slot. A message stays in the read-only editor until the Host accepts it;
 * only then does the editor clear, and a refusal or failure returns it to
 * editing unchanged.
 */
import type { InputSubmitMode, MessageSubmission } from '../contract/composer-submission.ts'
import type { DraftQuote, Occurrence } from '../contract/draft-editor.ts'
import type {
  CommandClaim, DraftAttachmentId, InputEffect, InputEvent, InputState, SubmitAttempt,
} from '../contract/input.ts'

/** Exhaustiveness backstop for the closed InputEvent union. */
function unreachable(value: never): never {
  throw new Error(`unreachable input event: ${JSON.stringify(value)}`)
}

/** Strip a claimed command token from its submit-time draft. */
function argsAfter(draft: string, token: string): string {
  const s = draft.trimStart()
  if (s.startsWith(token)) return s.slice(token.length)
  const base = token.trimEnd()
  if (s.startsWith(base)) {
    const rest = s.slice(base.length)
    return /^\s/.test(rest) ? rest.slice(1) : rest
  }
  return ''
}

/** The submit-plane slice of the published InputState. */
export interface SubmitSnapshot {
  readonly phase: InputState['phase']
  readonly claim?: InputState['claim']
}

/** Pure phase, claim, and attempt owner for one Session input. */
export class SubmitMachine {
  private phase: InputState['phase'] = 'plain'
  private claim: CommandClaim | undefined
  private seq = 0
  private inflight: {
    readonly attempt: SubmitAttempt
    readonly controller: AbortController
  } | undefined

  /** Read-only snapshot of the submit-plane state. */
  get state(): SubmitSnapshot {
    const c = this.claim
    return {
      phase: this.phase,
      ...(c
        ? {
          claim: {
            name: c.name,
            token: c.token,
            ...(c.hint !== undefined ? { hint: c.hint } : {}),
            ...(c.attachments === true ? { attachments: true } : {}),
          },
        }
        : {}),
    }
  }

  /** The attempt of the message being sent; undefined outside the sending phase. */
  get sendingAttempt(): SubmitAttempt | undefined {
    return this.phase === 'sending' ? this.inflight?.attempt : undefined
  }

  /**
   * Feed one event through the machine.
   * @param ev - submit-plane event.
   * @returns effects for the SessionInput shell, in execution order.
   */
  dispatch(ev: InputEvent): readonly InputEffect[] {
    switch (ev.type) {
      case 'draft-changed': return this.followCommand(ev.command)
      case 'claim': return this.followCommand(ev.claim)
      case 'enter': return this.onEnter(ev)
      case 'adjudicated': return this.onAdjudicated(ev.attempt, ev.outcome)
      case 'adjudication-failed': return this.onAdjudicationFailed(ev.attempt, ev.message)
      case 'submit-settled': return this.onSubmitSettled(ev)
      case 'sink-settled': return this.onSinkSettled(ev)
      case 'release': return this.onRelease()
      default: return unreachable(ev)
    }
  }

  /**
   * Outside a transaction the claim follows the document's leading command
   * chip: deleting or displacing the chip releases it, and a history restore
   * of the chip re-enters claimed. The claim event applies the same rule to a
   * chip the editor just inserted, before its update commits; busy phases
   * refuse both.
   */
  private followCommand(command: CommandClaim | undefined): readonly InputEffect[] {
    if (this.phase !== 'plain' && this.phase !== 'claimed') return []
    this.claim = command
    this.phase = command === undefined ? 'plain' : 'claimed'
    return []
  }

  /** Occupy the frozen slot with the draft, references, quotes, and attachments the user sent. */
  private beginAttempt(
    mode: InputSubmitMode,
    draft: string,
    occurrences: readonly Occurrence[],
    quotes: readonly DraftQuote[],
    attachmentIds: readonly DraftAttachmentId[],
    submission?: MessageSubmission,
  ): SubmitAttempt {
    const controller = new AbortController()
    this.seq += 1
    const attempt: SubmitAttempt = {
      seq: this.seq,
      signal: controller.signal,
      draftSnapshot: draft,
      occurrences,
      quotes,
      attachmentIds,
      mode,
      ...submission === undefined ? {} : { submission },
    }
    this.inflight = { attempt, controller }
    return attempt
  }

  /** Send the frozen message; the editor stays read-only until the Host accepts it. */
  private send(attempt: SubmitAttempt): readonly InputEffect[] {
    this.claim = undefined
    this.phase = 'sending'
    return [{ type: 'default-sink', attempt, draft: attempt.draftSnapshot, mode: attempt.mode }]
  }

  private onEnter(ev: Extract<InputEvent, { type: 'enter' }>): readonly InputEffect[] {
    if (this.phase === 'adjudicating' || this.phase === 'submitting' || this.phase === 'sending') return []
    const { mode, draft, occurrences, quotes, attachmentIds, submission } = ev
    if (this.phase === 'claimed' && this.claim !== undefined) {
      const attempt = this.beginAttempt(mode, draft, occurrences, quotes, attachmentIds, submission)
      this.phase = 'submitting'
      return [{ type: 'begin-submit', attempt, claim: this.claim, args: argsAfter(draft, this.claim.token) }]
    }
    const trimmed = draft.trim()
    if (trimmed === '' && attachmentIds.length === 0) return []
    const attempt = this.beginAttempt(mode, draft, occurrences, quotes, attachmentIds, submission)
    if (trimmed.startsWith('/')) {
      this.phase = 'adjudicating'
      return [{ type: 'adjudicate', attempt, draft }]
    }
    return this.send(attempt)
  }

  private onAdjudicated(
    attempt: SubmitAttempt,
    outcome: Extract<InputEvent, { type: 'adjudicated' }>['outcome'],
  ): readonly InputEffect[] {
    const flight = this.inflight
    if (this.phase !== 'adjudicating' || flight === undefined || flight.attempt.seq !== attempt.seq) return []
    if (outcome !== undefined && outcome !== 'handled' && 'claim' in outcome) {
      this.claim = outcome.claim
      this.phase = 'submitting'
      return [{
        type: 'begin-submit',
        attempt,
        claim: outcome.claim,
        args: argsAfter(attempt.draftSnapshot, outcome.claim.token),
      }]
    }
    if (outcome === undefined) return this.send(attempt)
    this.inflight = undefined
    this.phase = 'plain'
    return []
  }

  private onAdjudicationFailed(attempt: SubmitAttempt, message: string): readonly InputEffect[] {
    if (this.phase !== 'adjudicating' || this.inflight?.attempt.seq !== attempt.seq) return []
    this.inflight = undefined
    this.phase = 'plain'
    return [{ type: 'notice', level: 'error', text: message }]
  }

  /** Claimed command settlement; after a failure the claim follows the leading command chip again. */
  private onSubmitSettled(ev: Extract<InputEvent, { type: 'submit-settled' }>): readonly InputEffect[] {
    const flight = this.inflight
    if (this.phase !== 'submitting' || flight === undefined || flight.attempt.seq !== ev.attempt.seq) return []
    this.inflight = undefined
    if (ev.ok) {
      this.phase = 'plain'
      this.claim = undefined
      const effects: InputEffect[] = [{ type: 'commit-draft', retainSuffixOf: flight.attempt.draftSnapshot }]
      if (ev.outcome?.text !== undefined) {
        effects.push({ type: 'notice', level: ev.outcome.kind === 'error' ? 'error' : 'info', text: ev.outcome.text })
      }
      return effects
    }
    const text = ev.message ?? ev.outcome?.text
    this.claim = ev.command
    this.phase = ev.command === undefined ? 'plain' : 'claimed'
    return text === undefined ? [] : [{ type: 'notice', level: 'error', text }]
  }

  /** An accepted message clears the editor; a refused or failed one returns to editing unchanged. */
  private onSinkSettled(ev: Extract<InputEvent, { type: 'sink-settled' }>): readonly InputEffect[] {
    const flight = this.inflight
    if (this.phase !== 'sending' || flight === undefined || flight.attempt.seq !== ev.attempt.seq) return []
    this.inflight = undefined
    this.phase = 'plain'
    const effects: InputEffect[] = ev.ok ? [{ type: 'commit-draft', retainSuffixOf: null }] : []
    const text = ev.message ?? ev.outcome?.text
    if (text !== undefined) {
      effects.push({ type: 'notice', level: ev.ok && ev.outcome?.kind !== 'error' ? 'info' : 'error', text })
    }
    return effects
  }

  private onRelease(): readonly InputEffect[] {
    if (this.inflight !== undefined) {
      this.inflight.controller.abort()
      this.inflight = undefined
    }
    this.phase = 'plain'
    this.claim = undefined
    return []
  }
}
