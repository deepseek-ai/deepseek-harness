/** Directory spellings that descend from a workspace root, under POSIX and Windows roots. */
import { describe, expect, it } from 'vitest'
import { workspaceDescent } from '../src/descent.ts'

describe('workspaceDescent', () => {
  it('names the root as the empty path and a descendant by its `/`-joined child names', () => {
    expect(workspaceDescent('/work/app', '/work/app')).toBe('')
    expect(workspaceDescent('/work/app/', '/work/app/src')).toBe('src')
    expect(workspaceDescent('/work/app', '/work/app/src/lib')).toBe('src/lib')
    expect(workspaceDescent('/', '/etc')).toBe('etc')
  })

  it('reads empty and `.` segments as no step, and refuses a `..` segment', () => {
    expect(workspaceDescent('/work/app', '/work/app//src/./lib')).toBe('src/lib')
    expect(workspaceDescent('/work/app', '/work/app/link/..')).toBeUndefined()
    expect(workspaceDescent('/work/app', '/work/app/link/../src')).toBeUndefined()
    expect(workspaceDescent('/work/app', '/work/app/src/..hidden')).toBe('src/..hidden')
  })

  it('reads child names after a root that itself holds a `..` segment', () => {
    expect(workspaceDescent('/ws/../ws/./sub', '/ws/../ws/./sub/link/nested')).toBe('link/nested')
    expect(workspaceDescent('/ws/../ws/./sub', '/ws/sub/link')).toBeUndefined()
  })

  it('refuses a directory spelled above or beside the root, and an expanded home directory', () => {
    expect(workspaceDescent('/work/app', '/work')).toBeUndefined()
    expect(workspaceDescent('/work/app', '/work/other')).toBeUndefined()
    expect(workspaceDescent('/work/app', '/work/app-two')).toBeUndefined()
    expect(workspaceDescent('/work/app', '/home/user')).toBeUndefined()
  })

  it('reads a Windows root by its own separator and exact spelling', () => {
    expect(workspaceDescent('C:\\Work\\App', 'C:\\Work\\App')).toBe('')
    expect(workspaceDescent('C:\\Work\\App', 'C:\\Work\\App\\src\\lib')).toBe('src/lib')
    expect(workspaceDescent('C:\\', 'C:\\Users')).toBe('Users')
    expect(workspaceDescent('\\\\server\\share\\app', '\\\\server\\share\\app\\src')).toBe('src')
    expect(workspaceDescent('C:\\Work\\App', 'C:\\Work\\App\\link\\..\\src')).toBeUndefined()
    expect(workspaceDescent('C:\\Work\\App', 'c:\\work\\app\\src')).toBeUndefined()
    expect(workspaceDescent('C:\\Work\\App', 'C:\\Work')).toBeUndefined()
  })

  it('refuses a directory on another drive, whichever separators spell the root', () => {
    expect(workspaceDescent('C:\\Work\\App', 'D:\\Work\\App\\src')).toBeUndefined()
    expect(workspaceDescent('\\\\server\\share\\workspace', 'C:\\outside')).toBeUndefined()
    expect(workspaceDescent('//server/share/workspace', 'C:\\outside')).toBeUndefined()
    expect(workspaceDescent('//tmp/x', '/etc')).toBeUndefined()
  })

  it('refuses a root spelling that is not absolute', () => {
    expect(workspaceDescent('work/app', 'work/app/src')).toBeUndefined()
    expect(workspaceDescent('ssh://host/work/app', 'ssh://host/work/app/src')).toBeUndefined()
  })

  it('keeps a backslash as part of a name under a POSIX root', () => {
    expect(workspaceDescent('/work/app', '/work/app/src\\..\\lib')).toBe('src\\..\\lib')
  })
})
