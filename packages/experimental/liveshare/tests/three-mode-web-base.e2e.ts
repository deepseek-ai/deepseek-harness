/**
 * Real web-profile base for the three-mode acceptance driver.
 *
 * One isolated `dsh web` instance answers over its own HTTP carrier; two prompts really run against
 * a real Session, controller, and tool executor behind a keyless deterministic model route. The
 * three viewer mode cases attach on top of this same harness.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bootWebOwner, openStream, redact, wireList, wireObject, type Wire } from './three-mode-web-harness.ts'

describe('three-mode acceptance: real web-profile base', () => {
  // A flake here is a real failure of the base, so the driver never retries it.
  it('drives two prompts through one real Session', { timeout: 150_000, retry: 0 }, async () => {
    const owner = await bootWebOwner()
    const sessionId = await owner.createSession()

    // The two prompts are separated by the first turn's real end, not by a promise receipt.
    await owner.prompt(sessionId, 'NO_TOOL', 'acceptance-turn-1')

    // Real stream observation: session/control's first frame is the baseline (queues/jobs/projections).
    const control = await openStream({
      origin: owner.origin,
      cookie: owner.cookie,
      endpoint: 'session/control',
      args: {},
      until: frame => frame.type === 'item' && frame.value?.type === 'baseline',
      timeoutMs: 15_000,
    })
    await control.close()
    const baseline = control.frames.find(frame => frame.value?.type === 'baseline')?.value
    const queues = baseline?.value?.queues
    const projections = baseline?.value?.projections
    const jobEntry = baseline?.value?.jobs?.[sessionId]
    const queueRow = queues?.[sessionId]
    owner.facts.push(
      `controlQueueLen=${Array.isArray(queueRow) ? String(wireList(queueRow).length) : 'n/a'}`,
      `controlJobHere=${JSON.stringify(jobEntry ?? null).slice(0, 240)}`,
      `controlAsOfSeq=${String(projections?.[sessionId]?.asOfSeq ?? 'n/a')}`,
    )

    // The mux carrier keeps delivering gap-free live events after its opening snapshot, so this
    // observes the turn as it really ends rather than reading a settled file.
    const follow = await openStream({
      origin: owner.origin,
      cookie: owner.cookie,
      endpoint: 'session/follow',
      args: { request: { address: { kind: 'session', sessionId }, maxMessages: 200 } },
      until: (_frame, frames) => followRecords(frames).some(carries('turn/end')),
      timeoutMs: 60_000,
    })
    await follow.close()
    const followed = followRecords(follow.frames)
    // A turn/end record carries `{turn, reason}`; the reason's `kind` is the only outcome.
    const followTurnEnds = followed.filter(carries('turn/end')).map((record) => {
      const reason = wireObject(record?.event?.data?.reason)
      const reasonError = reason?.error
      const error = reasonError === undefined
        ? ''
        : ` error=${redact(JSON.stringify(reasonError)).slice(0, 200)}`
      return `turn=${String(record?.event?.data?.turn ?? 'n/a')}`
        + ` reason=${reason?.kind ?? 'n/a'}${error}`
    })
    const assistantTexts = followed.filter(carries('assistant/message'))
      .flatMap(record => wireList(record?.event?.data?.message?.content))
      .filter((block: Wire) => block?.type === 'text')
      .map((block: Wire) => String(block.text))
    owner.facts.push(
      `followFrameCount=${String(follow.frames.length)}`,
      `followRecordCount=${String(followed.length)}`,
      // Every event kind present: a completed turn with no step or assistant text is not success.
      `followKinds=${JSON.stringify([...new Set(followed.map(kindOf))].slice(0, 16))}`,
      `followTurnEnds=${JSON.stringify(followTurnEnds)}`,
      `followStepCount=${String(followed.filter(carries('step/start')).length)}`,
      `followUserMessages=${String(followed.filter(carries('user/message')).length)}`,
      `followAssistantTexts=${JSON.stringify(assistantTexts).slice(0, 200)}`,
    )
    expect(followTurnEnds.length, "turn 1's turn/end on the live follow stream").toBe(1)
    expect(followTurnEnds[0]).toContain('reason=completed')
    // A completed turn alone proves neither a model call nor an answer: agent-loop completes an
    // initial step with no messages by returning early, without ever calling the model.
    expect(followed.filter(carries('step/start')).length, 'turn 1 opened a model step')
      .toBeGreaterThan(0)
    expect(assistantTexts.join(''), 'turn 1 assistant text from the deterministic model')
      .toContain('BASE_NO_TOOL_OK')
    expect(assistantTexts.join(''), 'no fixture loop marker').not.toContain('LOOPED')

    // The same turn as the durable log records it, selected by this Session's header id.
    const firstTurn = await owner.waitFor('turn 1 to end',
      records => records.filter(record => record.type === 'turn/end').length >= 1)
    const firstEnd = firstTurn.filter(record => record.type === 'turn/end')
    expect(firstEnd.length, 'turn 1 ended exactly once on disk').toBe(1)
    expect(firstEnd[0]?.data?.reason?.kind, JSON.stringify(firstEnd[0]?.data?.reason ?? {}).slice(0, 300))
      .toBe('completed')

    await owner.prompt(sessionId, 'WRITE_FILE', 'acceptance-turn-2')
    const records = await owner.waitFor('turn 2 to end',
      candidates => candidates.filter(record => record.type === 'turn/end').length >= 2)

    // Exact facts, not lower bounds: two completed turns and one successful write.
    const turnEnds = records.filter((record: Wire) => record.type === 'turn/end')
    expect(turnEnds.length, 'total turn/end records').toBe(2)
    expect(turnEnds.every((record: Wire) => record.data?.reason?.kind === 'completed'),
      'every turn end reports a completed reason').toBe(true)
    const writeCalls = records.filter(record => record.type === 'tool/call' && record.data?.name === 'write')
    expect(writeCalls.length, 'exactly one write call').toBe(1)
    // Field-by-field: the result message carries the call's own id and is not an error.
    const writeCallId = writeCalls[0]?.data?.callId
    expect(typeof writeCallId, 'write call id').toBe('string')
    const results = records.filter((record: Wire) => record.type === 'tool/result')
      .map((record: Wire) => record.data?.message)
    const mine = results.filter((message: Wire | undefined) => message?.toolCallId === writeCallId)
    expect(mine.length, 'one result message for the write call').toBe(1)
    expect(mine[0]?.isError, 'the write result is not an error').toBe(false)
    expect(JSON.stringify(records).includes('LOOPED'), 'fixture loop marker').toBe(false)
    const bytes = await readFile(join(owner.cwd, 'note.txt'))
    expect(bytes.toString('utf8')).toBe('hello from the real write tool\n')
    // Reported, not asserted: this is the evidence a reader checks against the claims above.
    console.log([
      '--- three-mode web base facts ---',
      `sessionId=${sessionId}`,
      `turnEndsOnDisk=${JSON.stringify(turnEnds.map((record: Wire) => ({
        turn: record.data?.turn, reason: record.data?.reason?.kind,
      })))}`,
      `writeCallId=${String(writeCallId)} writeResultIsError=${String(mine[0]?.isError)}`,
      `note.txt=${JSON.stringify(bytes.toString('utf8'))} bytes=${String(bytes.byteLength)}`,
      `stderr=${redact(owner.stderr().slice(-300)) || '<empty>'}`,
      ...owner.facts,
      'fixtureAdapterCalls:',
      redact(await owner.fixtureCalls()).trimEnd(),
      '--- end facts ---',
    ].join('\n'))
  })
})

/** Event name one follow record carries; the carrier nests the durable event under `event`. */
function kindOf(record: Wire): string {
  return record?.event?.type ?? record?.type ?? 'unknown'
}

/** Predicate for one durable event name on a follow record. */
function carries(type: string): (record: Wire) => boolean {
  return record => kindOf(record) === type
}

/** Every durable record a follow socket delivered: the opening snapshot, then live events. */
function followRecords(frames: readonly Wire[]): Wire[] {
  const records: Wire[] = []
  for (const frame of frames) {
    const value = frame.value
    if (value === undefined) continue
    if (value.type === 'snapshot') records.push(...wireList(value.records))
    else if (value.type === 'event') records.push(value)
  }
  return records
}
