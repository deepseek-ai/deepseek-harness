import { describe, expect, it } from 'vitest'
import { parseSessionFormatLogFilename, sessionFormatLogFilename } from '../src/index.ts'

describe('canonical Session log filenames', () => {
  it('names version zero without a generation component and later generations with .vN', () => {
    expect(sessionFormatLogFilename(0)).toBe('session.jsonl')
    expect(sessionFormatLogFilename(1)).toBe('session.v1.jsonl')
    expect(sessionFormatLogFilename(27)).toBe('session.v27.jsonl')
    for (const invalid of [-1, -0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => sessionFormatLogFilename(invalid)).toThrow(/non-negative safe integer/)
    }
  })

  it('parses only canonical raw generation names', () => {
    expect(parseSessionFormatLogFilename('session.jsonl')).toBe(0)
    expect(parseSessionFormatLogFilename('session.v1.jsonl')).toBe(1)
    expect(parseSessionFormatLogFilename('session.v27.jsonl')).toBe(27)
    expect(parseSessionFormatLogFilename('session.v9007199254740992.jsonl')).toBeUndefined()
    for (const name of [
      'session.v0.jsonl',
      'session.v01.jsonl',
      'session.V1.jsonl',
      'session.v1.backup.jsonl',
      'session.migration.deadbeef.tmp.jsonl',
      'session.v1.jsonl.zstd',
      'session.1.jsonl',
    ]) {
      expect(parseSessionFormatLogFilename(name)).toBeUndefined()
    }
  })
})
