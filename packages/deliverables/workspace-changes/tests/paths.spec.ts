/** Display, durable, canonical, and temporary path rules. */
import { mkdir, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalPath, compareDisplay, displayPathOf, durablePathOf, isTemporaryPath, temporaryRoots } from '../src/paths.ts'
import { scratchDir } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

const cwd = '/home/u/proj/pkg'
const root = '/home/u/proj'
const home = '/home/u'

describe('displayPathOf', () => {
  it('prefers cwd-relative, then repository-relative, then home, then absolute', () => {
    expect(displayPathOf('/home/u/proj/pkg/src/a.ts', cwd, root, home)).toBe('src/a.ts')
    expect(displayPathOf('/home/u/proj/other/b.ts', cwd, root, home)).toBe('../other/b.ts')
    expect(displayPathOf('/home/u/.zshrc', cwd, root, home)).toBe('~/.zshrc')
    expect(displayPathOf('/etc/hosts', cwd, root, home)).toBe('/etc/hosts')
    expect(displayPathOf('/home/u/.zshrc', cwd, root, '')).toBe('/home/u/.zshrc')
  })
})

describe('durablePathOf', () => {
  it('keeps cwd-relative paths relative and everything else absolute', () => {
    expect(durablePathOf('/home/u/proj/pkg/a.ts', cwd)).toBe('a.ts')
    expect(durablePathOf('/home/u/proj/b.ts', cwd)).toBe('/home/u/proj/b.ts')
  })
})

describe('temporary paths', () => {
  it('matches the platform temp roots in raw and canonical form and keeps missing candidates lexical', async () => {
    const roots = await temporaryRoots()
    expect(roots).toContain('/tmp')
    expect(isTemporaryPath(join(tmpdir(), 'scratch.txt'), roots)).toBe(true)
    expect(isTemporaryPath('/tmp/x', roots)).toBe(true)
    expect(isTemporaryPath('/tmpfoo/x', roots)).toBe(false)
    expect(isTemporaryPath('/home/u/x', roots)).toBe(false)
    expect(await temporaryRoots(['/definitely/missing/root'])).toEqual(['/definitely/missing/root'])
  })
})

describe('canonicalPath', () => {
  it('resolves a missing file through the nearest existing ancestor, so its spelling is stable before and after creation', async () => {
    const root = await scratchDir('dsh-canonical-', cleanups)
    const real = join(root, 'real')
    await mkdir(join(real, 'nested'), { recursive: true })
    await symlink(real, join(root, 'link'))
    const resolvedReal = await realpath(real)
    expect(await canonicalPath(join(root, 'link', 'nested'))).toBe(join(resolvedReal, 'nested'))
    expect(await canonicalPath(join(root, 'link', 'nested', 'new.txt'))).toBe(join(resolvedReal, 'nested', 'new.txt'))
    expect(await canonicalPath(join(root, 'link', 'missing', 'deeper', 'new.txt'))).toBe(join(resolvedReal, 'missing', 'deeper', 'new.txt'))
    // Nothing but the root exists above this path, so its spelling is kept as given on every platform.
    expect(await canonicalPath('/definitely/missing/root/file')).toBe('/definitely/missing/root/file')
    expect(await canonicalPath(join(root, 'link', 'a'))).toBe(join(resolvedReal, 'a'))
  })
})

describe('compareDisplay', () => {
  it('orders by code units so parent and absolute paths lead', () => {
    const sorted = [{ display: 'src/b' }, { display: '~/x' }, { display: '../a' }, { display: '/etc/h' }, { display: 'src/a' }].sort(compareDisplay)
    expect(sorted.map(file => file.display)).toEqual(['../a', '/etc/h', 'src/a', 'src/b', '~/x'])
    expect(compareDisplay({ display: 'a' }, { display: 'a' })).toBe(0)
  })
})
