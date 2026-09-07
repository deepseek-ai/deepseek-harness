import { describe, expect, it } from 'vitest'
import { SpillLocator } from '@deepseek-ai/dsh-spill'
import { formatSpillNotice, hasSpillNotice } from '../src/notice.ts'

const ref = { locator: SpillLocator('/spill/output.txt'), retrievalHint: 'Read the file.' }

describe('persisted spill notice', () => {
  it('preserves the historical spelling independently of the formatter', () => {
    const historical = '(Omitted 50000 bytes. Full formatted result stored at: /spill/output.txt. Read the file.)'
    expect(formatSpillNotice({ kind: 'exact', count: 50000 }, ref)).toBe(historical)
    expect(hasSpillNotice(historical)).toBe(true)
    expect(hasSpillNotice(`failed\n[exit code: 7]\n\n${historical}`)).toBe(true)
  })

  it('recognizes every omission form the producer can format', () => {
    for (const omitted of [{ kind: 'none' }, { kind: 'unknown' }, { kind: 'exact', count: 0 }] as const) {
      const notice = formatSpillNotice(omitted, ref)
      expect(hasSpillNotice(notice)).toBe(true)
      expect(hasSpillNotice(`preview\n\n${notice}`)).toBe(true)
    }
  })

  it('keeps locator and retrieval text opaque, including parentheses and newlines', () => {
    const notice = formatSpillNotice({ kind: 'exact', count: 42 }, {
      locator: SpillLocator('/spill/报告 (1).txt'), retrievalHint: 'Read it.\n\n(additional guidance)',
    })
    expect(hasSpillNotice(notice)).toBe(true)
    expect(hasSpillNotice(`preview\n\n${notice}`)).toBe(true)
  })

  it('scans repeated non-notice prefixes without losing the final notice', () => {
    const prefix = '\n\n(ordinary output'.repeat(20000)
    expect(hasSpillNotice(prefix + ')')).toBe(false)
    const notice = formatSpillNotice({ kind: 'exact', count: 42 }, ref)
    expect(hasSpillNotice(prefix + '\n\n' + notice)).toBe(true)
  })

  it('rejects ordinary, partial, non-final, and malformed notice text', () => {
    const notice = formatSpillNotice({ kind: 'exact', count: 42 }, ref)
    for (const text of [
      '', 'ordinary output)', '(ordinary output)', '\n\n(ordinary output)', 'prefix' + notice,
      notice.slice(0, -1), notice + '\nother output',
      notice.replace('42', '-1'), notice.replace('42', '1.5'), notice.replace('42', '0042'),
      notice.replace('Omitted', 'Ignored'), notice.replace('. Read the file.', ''),
    ]) expect(hasSpillNotice(text)).toBe(false)
  })
})
