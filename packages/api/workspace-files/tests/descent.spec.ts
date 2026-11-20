/** Paths written as a descent from a workspace root, under POSIX and Windows spellings. */
import { describe, expect, it } from 'vitest'
import { workspaceDescent } from '../src/descent.ts'

describe('workspaceDescent', () => {
  it('names the root as the empty path and a descendant by its `/`-joined child names', () => {
    expect(workspaceDescent('/work/app', '.')).toBe('')
    expect(workspaceDescent('/work/app', '/work/app/')).toBe('')
    expect(workspaceDescent('/work/app', 'src/./lib')).toBe('src/lib')
    expect(workspaceDescent('/work/app', '/work/app/src/lib')).toBe('src/lib')
  })

  it('refuses a path with a `..` segment, including one that is written back below the root', () => {
    expect(workspaceDescent('/work/app', 'link/..')).toBeUndefined()
    expect(workspaceDescent('/work/app', '/work/app/link/../src')).toBeUndefined()
    expect(workspaceDescent('/work/app', 'src/..hidden')).toBe('src/..hidden')
  })

  it('refuses an absolute path that is the parent of the root or beside it', () => {
    expect(workspaceDescent('/work/app', '/work')).toBeUndefined()
    expect(workspaceDescent('/work/app', '/work/other')).toBeUndefined()
    expect(workspaceDescent('/work/app', '/work/app-two')).toBeUndefined()
  })

  it('reads a Windows root with either separator and without regard to case', () => {
    expect(workspaceDescent('C:\\Work\\App', 'C:\\work\\app/src\\lib')).toBe('src/lib')
    expect(workspaceDescent('C:\\Work\\App', 'src\\..\\lib')).toBeUndefined()
    expect(workspaceDescent('C:\\Work\\App', 'C:\\Work')).toBeUndefined()
    expect(workspaceDescent('C:\\Work\\App', 'D:\\Work\\App\\src')).toBeUndefined()
  })

  it('keeps a backslash as part of a name under a POSIX root', () => {
    expect(workspaceDescent('/work/app', 'src\\..\\lib')).toBe('src\\..\\lib')
  })
})
