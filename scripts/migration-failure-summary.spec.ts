import { describe, expect, it } from 'vitest'
import { classifyMigrationFailure } from './migration-failure-summary.ts'

function failure(name: string, message: string): Error {
  return Object.assign(new Error(message), { name })
}

describe('migration failure report facts', () => {
  it('distinguishes a direct field refusal from a child prerequisite failure', () => {
    const message = '@deepseek-ai/dsh-session-format-v0-to-v1 refuses this format v0 Session: '
      + 'permission/preset 0 data has unexpected member "origin"; source v0 artifact remains unchanged'
    const direct = classifyMigrationFailure(failure('SessionFormatUnsupportedError', message))
    expect(direct).toEqual({ reason: 'unexpected_member', errorName: 'SessionFormatUnsupportedError',
      message, eventType: 'permission/preset', member: 'origin' })
    const child = classifyMigrationFailure(failure('SessionFormatUnsupportedError', `child Session fixture-child: ${message}`))
    expect(child).toMatchObject({ reason: 'unexpected_member', child: true, eventType: direct.eventType, member: direct.member })
  })

  it.each(['historical ', ''])('extracts unknown %sevent names', (qualifier) => {
    const message = `format v0 contains unknown ${qualifier}event type "fixture/event" at seq 3`
    expect(classifyMigrationFailure(failure('SessionFormatUnsupportedError', message)))
      .toEqual({ reason: 'unknown_event', errorName: 'SessionFormatUnsupportedError', message, eventType: 'fixture/event' })
  })

  it('retains sequence values without diagnosing the producer or repairing the log', () => {
    const message = 'session "fixture": stored log is corrupt: SessionFormatError: released v2 row 8 has seq gap (expected 8, got 5)'
    expect(classifyMigrationFailure(failure('SessionPersistenceCorruptionError', message)))
      .toEqual({ reason: 'sequence_gap', errorName: 'SessionPersistenceCorruptionError', message, expectedSeq: 8, actualSeq: 5 })
  })

  it.each([
    ['JsonlGenerationSourceChangedError', 'source_changed'],
    ['SessionAlreadyOwnedError', 'write_locked'],
    ['SessionFormatUnsupportedError', 'unsupported_input'],
    ['SessionPersistenceCorruptionError', 'corrupt_log'],
    ['Error', 'other'],
  ])('preserves unrecognized text for %s', (name, reason) => {
    expect(classifyMigrationFailure(failure(name, 'unrecognized diagnostic')))
      .toEqual({ reason, errorName: name, message: 'unrecognized diagnostic' })
  })

  it('keeps non-Error failures in the report', () => {
    expect(classifyMigrationFailure('cancelled')).toEqual({ reason: 'other', errorName: 'NonError', message: 'cancelled' })
  })
})
