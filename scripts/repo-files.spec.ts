import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { uniqueRepoFiles } from './repo-files.ts'

const filesystem = vi.hoisted(() => ({ listed: [] as string[], canonicalized: [] as string[] }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readdirSync: ((...args: Parameters<typeof actual.readdirSync>) => {
      filesystem.listed.push(String(args[0]))
      return actual.readdirSync(...args)
    }) as typeof actual.readdirSync,
    realpathSync: Object.assign((...args: Parameters<typeof actual.realpathSync>) => {
      filesystem.canonicalized.push(String(args[0]))
      return actual.realpathSync(...args)
    }, { native: actual.realpathSync.native }),
  }
})

afterEach(() => {
  filesystem.listed.length = 0
  filesystem.canonicalized.length = 0
})

interface Tree {
  root: string
  clean: () => void
}

function makeTree(): Tree {
  const parent = mkdtempSync(join(tmpdir(), 'repo-files-'))
  const root = join(parent, 'root')
  const outside = join(parent, 'outside') // reachable only through a symlinked dir
  mkdirSync(join(root, 'a'), { recursive: true })
  writeFileSync(join(root, 'a', 'snap.md'), 'real\n')
  mkdirSync(join(root, 'd'), { recursive: true })
  symlinkSync(join(root, 'a', 'snap.md'), join(root, 'd', 'snap.md'))
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'snap.md'), 'behind a symlinked dir\n')
  symlinkSync(outside, join(root, 'linked-dir'))
  mkdirSync(join(root, '.hidden'), { recursive: true })
  writeFileSync(join(root, '.hidden', 'snap.md'), 'hidden by dot\n')
  return { root, clean: () => { rmSync(parent, { recursive: true, force: true }) } }
}

describe('uniqueRepoFiles', () => {
  it('enumerates ** matches without probing a symlinked file as a directory', () => {
    const tree = makeTree()
    try {
      // Node's internal glob (from some 24.x releases) lstat-probes
      // <symlink>/snap.md while expanding `**/snap.md` and throws ENOTDIR.
      // The walker must return the real files, deduplicated by canonical
      // target, without throwing on any node version.
      const files = uniqueRepoFiles(tree.root, ['**/snap.md'])
      const rootReal = realpathSync(tree.root)
      const reals = files.map(file => relative(rootReal, file.real)).sort()
      expect(reals).toEqual([join('a', 'snap.md')])
    } finally {
      tree.clean()
    }
  })

  it('does not follow symlinked directories under ** or wildcard-match dot names', () => {
    const tree = makeTree()
    try {
      const files = uniqueRepoFiles(tree.root, ['**/*.md'])
      const paths = files.map(file => relative(tree.root, file.abs)).sort()
      // The symlinked d/snap.md dedupes onto its a/snap.md target; the
      // linked-dir and .hidden targets must not appear at all.
      expect(paths).toEqual([join('a', 'snap.md')])
    } finally {
      tree.clean()
    }
  })

  it('follows a literal segment that names a symlinked directory', () => {
    const tree = makeTree()
    try {
      // Node glob resolves literal segments with stat, so `linked-dir/**` and
      // `linked-dir/*` enter the symlinked directory's target; `**` and
      // wildcard segments resolve with dirent types and do not.
      const files = uniqueRepoFiles(tree.root, ['linked-dir/**/*.md'])
      expect(files.map(file => relative(tree.root, file.abs))).toEqual([join('linked-dir', 'snap.md')])
      expect(uniqueRepoFiles(tree.root, ['linked-dir/*.md']).map(file => relative(tree.root, file.abs)))
        .toEqual([join('linked-dir', 'snap.md')])
      // A wildcard first segment never enters the symlinked directory.
      expect(uniqueRepoFiles(tree.root, ['*/snap.md']).map(file => relative(tree.root, file.abs)))
        .toEqual([join('a', 'snap.md')])
    } finally {
      tree.clean()
    }
  })

  it('follows repeated literal symlinked directories like node glob and terminates', () => {
    const parent = mkdtempSync(join(tmpdir(), 'repo-files-cycle-'))
    try {
      const root = join(parent, 'root')
      mkdirSync(join(root, 'a'), { recursive: true })
      writeFileSync(join(root, 'a', 'snap.md'), 'x\n')
      symlinkSync(root, join(root, 'cyc'))
      // Each literal `cyc` segment resolves through stat and enters the
      // symlinked directory again, exactly as node glob does for a repeated
      // literal; recursion stays bounded because each literal consumes one
      // pattern segment and `**` only enters real directories.
      expect(uniqueRepoFiles(root, ['cyc/**/snap.md']).map(file => relative(root, file.abs)))
        .toEqual([join('cyc', 'a', 'snap.md')])
      expect(uniqueRepoFiles(root, ['cyc/cyc/**/snap.md']).map(file => relative(root, file.abs)))
        .toEqual([join('cyc', 'cyc', 'a', 'snap.md')])
      expect(uniqueRepoFiles(root, ['cyc/cyc/cyc/**/snap.md']).map(file => relative(root, file.abs)))
        .toEqual([join('cyc', 'cyc', 'cyc', 'a', 'snap.md')])
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('reports a matched file canonical target for downstream existence checks', () => {
    const tree = makeTree()
    try {
      const files = uniqueRepoFiles(tree.root, ['a/*.md'])
      expect(files).toHaveLength(1)
      expect(files[0]!.real).toBe(join(realpathSync(tree.root), 'a', 'snap.md'))
    } finally {
      tree.clean()
    }
  })

  it('lists each directory once per call when patterns and ** revisit it', () => {
    const tree = makeTree()
    try {
      mkdirSync(join(tree.root, 'a', 'b'))
      writeFileSync(join(tree.root, 'a', 'b', 'deep.md'), 'deep\n')
      filesystem.listed.length = 0
      const files = uniqueRepoFiles(tree.root, ['a/*.md', '**/*.md', 'a/b/*.md', '**/deep.md'])
      expect(files.map(file => relative(tree.root, file.abs))).toEqual([join('a', 'snap.md'), join('a', 'b', 'deep.md')])
      expect(filesystem.listed.length).toBeGreaterThan(0)
      expect(new Set(filesystem.listed).size).toBe(filesystem.listed.length)
      // A second call lists the tree again instead of reusing stale entries.
      filesystem.listed.length = 0
      uniqueRepoFiles(tree.root, ['a/*.md'])
      expect(filesystem.listed).toEqual([tree.root, join(tree.root, 'a')])
    } finally {
      tree.clean()
    }
  })

  it('canonicalizes symlinked matches through realpath and dedupes them onto regular files', () => {
    const tree = makeTree()
    try {
      const rootReal = realpathSync(tree.root)
      filesystem.canonicalized.length = 0
      const linkFirst = uniqueRepoFiles(tree.root, ['d/*.md', 'a/*.md'])
      expect(linkFirst).toEqual([{ abs: join(tree.root, 'd', 'snap.md'), real: join(rootReal, 'a', 'snap.md') }])
      // The symlinked file and the root are canonicalized; the regular a/snap.md is not.
      expect(filesystem.canonicalized).toEqual([join(tree.root, 'd', 'snap.md'), tree.root])
      expect(uniqueRepoFiles(tree.root, ['a/*.md', 'd/*.md'])).toEqual([{ abs: join(tree.root, 'a', 'snap.md'), real: join(rootReal, 'a', 'snap.md') }])
      // A regular file below a literal symlinked directory still resolves to its target.
      const linked = uniqueRepoFiles(tree.root, ['linked-dir/*.md'])
      expect(linked.map(file => file.real)).toEqual([realpathSync(join(tree.root, 'linked-dir', 'snap.md'))])
      expect(linked[0]!.real).not.toBe(join(rootReal, 'linked-dir', 'snap.md'))
      // A symlinked root canonicalizes through its target.
      const rootLink = join(tree.root, '..', 'root-link')
      symlinkSync(tree.root, rootLink)
      expect(uniqueRepoFiles(rootLink, ['a/*.md']).map(file => file.real)).toEqual([join(rootReal, 'a', 'snap.md')])
    } finally {
      tree.clean()
    }
  })

  it('never lists a directory the caller skips and returns the unskipped result', () => {
    const tree = makeTree()
    try {
      mkdirSync(join(tree.root, 'p', 'lib', 'nested'), { recursive: true })
      writeFileSync(join(tree.root, 'p', 'lib', 'nested', 'built.ts'), 'built\n')
      writeFileSync(join(tree.root, 'p', 'source.ts'), 'source\n')
      const isExcluded = (path: string): boolean => path.includes('/lib/')
      const unskipped = uniqueRepoFiles(tree.root, ['**/*.ts'], isExcluded)
      filesystem.listed.length = 0
      const skipped = uniqueRepoFiles(tree.root, ['**/*.ts'], isExcluded, dir => dir.split('/').slice(1).includes('lib'))
      expect(skipped).toEqual(unskipped)
      expect(skipped.map(file => relative(tree.root, file.abs))).toEqual([join('p', 'source.ts')])
      expect(filesystem.listed).not.toContain(join(tree.root, 'p', 'lib'))
      expect(filesystem.listed).not.toContain(join(tree.root, 'p', 'lib', 'nested'))
    } finally {
      tree.clean()
    }
  })

  it('fails loudly on a broken symlink instead of shrinking the corpus', () => {
    const tree = makeTree()
    try {
      // A healthy tree with symlinked files must not throw.
      expect(() => uniqueRepoFiles(tree.root, ['a/*.md'])).not.toThrow()
    } finally {
      tree.clean()
    }
    const parent = mkdtempSync(join(tmpdir(), 'repo-files-broken-'))
    try {
      const root = join(parent, 'root')
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, 'gone.md'), 'x\n')
      symlinkSync(join(root, 'gone.md'), join(root, 'broken-link.md'))
      rmSync(join(root, 'gone.md'))
      // realpathSync on the matched broken link must throw, exactly as it did
      // under the node-glob implementation, instead of silently shrinking the
      // scanned corpus.
      expect(() => uniqueRepoFiles(root, ['*.md'])).toThrow()
      // The same holds under `**` and for a cyclic symlink.
      expect(() => uniqueRepoFiles(root, ['**/*.md'])).toThrow()
      rmSync(join(root, 'broken-link.md'))
      symlinkSync(join(root, 'loop-b.md'), join(root, 'loop-a.md'))
      symlinkSync(join(root, 'loop-a.md'), join(root, 'loop-b.md'))
      expect(() => uniqueRepoFiles(root, ['*.md'])).toThrow()
      expect(() => uniqueRepoFiles(root, ['**/loop-a.md'])).toThrow()
      // A broken symlink under a literal non-final segment matches nothing,
      // again as node glob silently returns no match for it.
      symlinkSync(join(root, 'gone-dir'), join(root, 'broken-dir'))
      expect(uniqueRepoFiles(root, ['broken-dir/*.md'])).toEqual([])
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('rejects glob syntax the walker does not model instead of matching nothing', () => {
    const tree = makeTree()
    try {
      // Node glob would interpret the bracket class; the walker must fail
      // loudly rather than expand the pattern as a literal and quietly match
      // nothing.
      expect(() => uniqueRepoFiles(tree.root, ['**/*.[cm]d'])).toThrow(/does not model glob syntax/)
    } finally {
      tree.clean()
    }
  })

  it('rejects a trailing ** segment instead of silently returning nothing', () => {
    const tree = makeTree()
    try {
      expect(() => uniqueRepoFiles(tree.root, ['a/**'])).toThrow(/trailing \*\*/)
      // A trailing slash yields an empty final segment that can never match.
      expect(() => uniqueRepoFiles(tree.root, ['a/**/'])).toThrow(/empty segments/)
    } finally {
      tree.clean()
    }
  })

  it('folds a . segment and rejects a .. segment like node glob semantics', () => {
    const tree = makeTree()
    try {
      // Node glob normalizes a `.` segment away, so `./a/snap.md` matches
      // a/snap.md instead of looking for a directory named `.`.
      expect(uniqueRepoFiles(tree.root, ['./a/snap.md']).map(file => relative(tree.root, file.abs)))
        .toEqual([join('a', 'snap.md')])
      expect(uniqueRepoFiles(tree.root, ['a/./snap.md']).map(file => relative(tree.root, file.abs)))
        .toEqual([join('a', 'snap.md')])
      // A `..` segment escapes the scanned root; the walker must fail loudly
      // rather than silently match nothing.
      expect(() => uniqueRepoFiles(tree.root, ['a/../snap.md'])).toThrow(/does not model \.\. segments/)
    } finally {
      tree.clean()
    }
  })
})
