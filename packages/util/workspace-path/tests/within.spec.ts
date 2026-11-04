import { describe, expect, it } from 'vitest'
import { within } from '@deepseek-ai/dsh-util-workspace-path'

describe('within', () => {
  it('tests containment lexically on canonical POSIX paths', () => {
    expect(within('/repo', '/repo')).toBe(true)
    expect(within('/repo', '/repo/src')).toBe(true)
    expect(within('/repo', '/repo-sibling')).toBe(false)
    expect(within('/repo', '/')).toBe(false)
    expect(within('/repo/src', '/repo')).toBe(false)
  })

  it('treats the filesystem root and a trailing separator as the same directory', () => {
    expect(within('/', '/')).toBe(true)
    expect(within('/', '/repo')).toBe(true)
    expect(within('/repo/', '/repo')).toBe(true)
    expect(within('/repo/', '/repo/src')).toBe(true)
    expect(within('/repo/', '/repo-sibling')).toBe(false)
  })

  it('compares Windows spellings case-insensitively with their own separator', () => {
    expect(within('C:\\repo', 'c:\\Repo\\src')).toBe(true)
    expect(within('C:\\repo', 'C:\\repo-sibling')).toBe(false)
    expect(within('C:\\', 'C:\\repo')).toBe(true)
    expect(within('C:/repo', 'C:/repo/src')).toBe(true)
    expect(within('C:/repo', 'C:/repo-sibling')).toBe(false)
    expect(within('\\\\server\\share', '\\\\server\\share\\dir')).toBe(true)
  })
})
