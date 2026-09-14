import { describe, expect, it } from 'vitest'
import {
  abbreviateHomePath, fileAddressFor, isAbsoluteWorkspacePath, parseFileAddress, pathPartsOf, relativizeToCwd,
  resolveWorkspacePath, workspaceTitleOf,
} from '@deepseek-ai/dsh-util-workspace-path'

describe('Workspace path helpers', () => {
  it('addresses every path by session and keeps absolute paths outside the workspace', () => {
    expect(fileAddressFor('s', '/w', 'src/a.ts')).toBe('dsh-resource://file/session/s/src/a.ts')
    expect(fileAddressFor('s', undefined, 'src/a.ts')).toBe('dsh-resource://file/session/s/src/a.ts')
    expect(fileAddressFor('s', '/w/', '/w/src/a.ts')).toBe('dsh-resource://file/session/s/src/a.ts')
    expect(fileAddressFor('s', '/w', '/w')).toBe('dsh-resource://file/session/s/')
    expect(fileAddressFor('s', '/w', '/work/a.ts')).toBe('dsh-resource://file/session/s//work/a.ts')
    expect(fileAddressFor('s', undefined, '/etc/hosts')).toBe('dsh-resource://file/session/s//etc/hosts')
    expect(fileAddressFor('s', 'C:\\w', 'C:\\w\\x.ts')).toBe('dsh-resource://file/session/s/x.ts')
    expect(fileAddressFor('s', 'C:\\w', 'D:\\x.ts')).toBe('dsh-resource://file/session/s/D:/x.ts')
    expect(fileAddressFor('s', undefined, '\\\\server\\share\\x.ts')).toBe('dsh-resource://file/session/s///server/share/x.ts')
    expect(fileAddressFor('s', '\\\\server\\share', '\\\\server\\share\\x.ts')).toBe('dsh-resource://file/session/s/x.ts')
  })

  it.each(['/workspace', undefined])('round-trips a parent-relative address with workspace root %s', (cwd) => {
    const address = fileAddressFor('s', cwd, '../outside/a.txt')
    expect(address).toBe('dsh-resource://file/session/s/../outside/a.txt')
    expect(parseFileAddress(address)).toEqual({ scope: 'session', sessionId: 's', path: '../outside/a.txt' })
  })

  it('classifies POSIX, Windows drive, and UNC paths as absolute and everything else as relative', () => {
    expect(isAbsoluteWorkspacePath('/a/b')).toBe(true)
    expect(isAbsoluteWorkspacePath('C:\\x\\a.ts')).toBe(true)
    expect(isAbsoluteWorkspacePath('C:/x/a.ts')).toBe(true)
    expect(isAbsoluteWorkspacePath('\\\\server\\share')).toBe(true)
    expect(isAbsoluteWorkspacePath('src/a.ts')).toBe(false)
    expect(isAbsoluteWorkspacePath('')).toBe(false)
  })

  it('resolves relative paths without changing absolute paths', () => {
    expect(resolveWorkspacePath('/w', 'src/a.ts')).toBe('/w/src/a.ts')
    expect(resolveWorkspacePath('/w/', '/abs/a.ts')).toBe('/abs/a.ts')
    expect(resolveWorkspacePath(undefined, 'src/a.ts')).toBe('src/a.ts')
    expect(resolveWorkspacePath('', 'src/a.ts')).toBe('src/a.ts')
    expect(resolveWorkspacePath('/w', 'C:\\x\\a.ts')).toBe('C:\\x\\a.ts')
    expect(resolveWorkspacePath('/w', '\\\\server\\share')).toBe('\\\\server\\share')
  })

  it('keeps Windows drive-root and directory joins fully qualified', () => {
    expect(resolveWorkspacePath('C:\\', 'src\\a.ts')).toBe('C:\\src\\a.ts')
    expect(resolveWorkspacePath('C:\\work\\', 'src\\a.ts')).toBe('C:\\work\\src\\a.ts')
    expect(resolveWorkspacePath('C:/work/', 'src/a.ts')).toBe('C:/work/src/a.ts')
  })

  it('abbreviates only descendants of a POSIX home', () => {
    expect(abbreviateHomePath('/Users/u', '/Users/u')).toBe('~')
    expect(abbreviateHomePath('/Users/u/', '/Users/u')).toBe('~')
    expect(abbreviateHomePath('/Users/u/Documents/project', '/Users/u')).toBe('~/Documents/project')
    expect(abbreviateHomePath('/Users/u2/a.ts', '/Users/u')).toBe('/Users/u2/a.ts')
    expect(abbreviateHomePath('/Users/u/a.ts')).toBe('/Users/u/a.ts')
    expect(abbreviateHomePath('/Users/u/a.ts', '')).toBe('/Users/u/a.ts')
    expect(abbreviateHomePath('/etc/hosts', '/')).toBe('/etc/hosts')
    expect(abbreviateHomePath('C:\\Users\\u\\project', 'C:\\Users\\u')).toBe('C:\\Users\\u\\project')
    expect(abbreviateHomePath('\\\\server\\share\\u', '\\\\server\\share\\u'))
      .toBe('\\\\server\\share\\u')
  })

  it('reads the final path segment on both path styles', () => {
    expect(workspaceTitleOf('/work/project/')).toBe('project')
    expect(workspaceTitleOf('C:\\work\\project\\')).toBe('project')
    expect(workspaceTitleOf('/')).toBe('')
  })

  it('splits a path for display after the last separator of either kind, keeping the separator with the directories', () => {
    expect(pathPartsOf('/work/project/notes.md')).toEqual({ directory: '/work/project/', name: 'notes.md' })
    expect(pathPartsOf('C:\\work\\project\\notes.md')).toEqual({ directory: 'C:\\work\\project\\', name: 'notes.md' })
    expect(pathPartsOf('\\\\host\\share/notes.md')).toEqual({ directory: '\\\\host\\share/', name: 'notes.md' })
    expect(pathPartsOf('/work/project/')).toEqual({ directory: '/work/', name: 'project' })
  })

  it('makes a separator-less or separator-only path all name', () => {
    expect(pathPartsOf('notes.md')).toEqual({ directory: '', name: 'notes.md' })
    expect(pathPartsOf('/')).toEqual({ directory: '', name: '/' })
  })

  it.each([
    ['/work/report.txt', '/work', 'report.txt'],
    ['/work/reports/result.pdf', '/work/', 'reports/result.pdf'],
    ['/work-other/report.txt', '/work', '/work-other/report.txt'],
    ['/other/report.txt', '/work', '/other/report.txt'],
    ['report.txt', '/work', 'report.txt'],
    ['/work/report.txt', undefined, '/work/report.txt'],
    ['/work/report.txt', '', '/work/report.txt'],
    ['/report.txt', '/', 'report.txt'],
    [String.raw`C:\work\reports\result.pdf`, String.raw`C:\work`, String.raw`reports\result.pdf`],
    [String.raw`\\server\share\report.txt`, String.raw`\\server\share`, 'report.txt'],
  ])('displays %s relative to %s only within that workspace', (path, cwd, label) => {
    expect(relativizeToCwd(path, cwd)).toBe(label)
  })
})
