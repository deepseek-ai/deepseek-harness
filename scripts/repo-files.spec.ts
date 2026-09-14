import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { uniqueRepoFiles } from './repo-files.ts'

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
