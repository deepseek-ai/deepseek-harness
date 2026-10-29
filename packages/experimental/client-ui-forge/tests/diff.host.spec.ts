/** Patch parsing into the panel's diff model, untracked files as added in full, and numstat records. */
import { describe, expect, it } from 'vitest'
import { decodeText, parseDiff, parseNumstat, untrackedFile } from '../src/diff.ts'

/**
 * A `git diff` patch with a binary change, a pure rename, a quoted path, a path
 * with a space, a non-ASCII path, an empty new file, an addition without a final
 * newline, and a deletion.
 */
const PATCH = [
  'diff --git a/bin.dat b/bin.dat',
  'index bdc955b..8352675 100644',
  'Binary files a/bin.dat and b/bin.dat differ',
  'diff --git a/old.txt b/new.txt',
  'similarity index 100%',
  'rename from old.txt',
  'rename to new.txt',
  'diff --git "a/quo\\"te.txt" "b/quo\\"te.txt"',
  'index bca70f3..9e1ab28 100644',
  '--- "a/quo\\"te.txt"',
  '+++ "b/quo\\"te.txt"',
  '@@ -1 +1,2 @@',
  ' q',
  '+z',
  'diff --git a/with space.txt b/with space.txt',
  'index de98044..7be73ce 100644',
  '--- a/with space.txt\t',
  '+++ b/with space.txt\t',
  '@@ -1,3 +1,3 @@',
  ' a',
  '-b',
  '+B',
  ' c',
  'diff --git a/中文.md b/中文.md',
  'index 587be6b..975fbec 100644',
  '--- a/中文.md',
  '+++ b/中文.md',
  '@@ -1 +1 @@',
  '-x',
  '+y',
  'diff --git a/empty.txt b/empty.txt',
  'new file mode 100644',
  'index 0000000..e69de29',
  'diff --git a/nonl.txt b/nonl.txt',
  'new file mode 100644',
  'index 0000000..20cbb4d',
  '--- /dev/null',
  '+++ b/nonl.txt',
  '@@ -0,0 +1 @@',
  '+no newline',
  '\\ No newline at end of file',
  'diff --git a/gone.txt b/gone.txt',
  'deleted file mode 100644',
  'index 9e1ab28..0000000',
  '--- a/gone.txt',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-q',
  '-z',
  '',
].join('\n')

describe('parseDiff', () => {
  it('maps every section of a Git patch to a file with its status, counts, and hunks', () => {
    expect(parseDiff(PATCH).map(({ path, previousPath, status, binary, untracked, additions, deletions }) =>
      [path, previousPath, status, binary, untracked, additions, deletions])).toEqual([
      ['bin.dat', null, 'modified', true, false, 0, 0],
      ['new.txt', 'old.txt', 'renamed', false, false, 0, 0],
      ['quo"te.txt', null, 'modified', false, false, 1, 0],
      ['with space.txt', null, 'modified', false, false, 1, 1],
      ['中文.md', null, 'modified', false, false, 1, 1],
      ['empty.txt', null, 'added', false, false, 0, 0],
      ['nonl.txt', null, 'added', false, false, 1, 0],
      ['gone.txt', null, 'deleted', false, false, 0, 2],
    ])
  })

  it('keeps the ranges and patch lines of each hunk, with an empty range starting at the line it comes before', () => {
    const files = parseDiff(PATCH)
    expect(files[3]?.hunks).toEqual([{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', ' c'] }])
    expect(files[6]?.hunks).toEqual([{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+no newline', '\\ No newline at end of file'] }])
    expect(files[7]?.hunks).toEqual([{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 0, lines: ['-q', '-z'] }])
  })

  it('takes paths without a prefix as they are and skips a section without a path', () => {
    expect(parseDiff('--- old\n+++ new\n@@ -1 +1 @@\n-a\n+b\n').map(file => [file.path, file.status])).toEqual([['new', 'modified']])
    expect(parseDiff('')).toEqual([])
  })
})

describe('untrackedFile', () => {
  it.each([
    ['a final newline', 'one\ntwo\n', ['+one', '+two']],
    ['no final newline', 'one\ntwo', ['+one', '+two', '\\ No newline at end of file']],
    ['carriage returns', 'one\r\ntwo\r\n', ['+one\r', '+two\r']],
  ])('adds every line of a text file with %s', (_label, text, lines) => {
    expect(untrackedFile('notes/new.md', new TextEncoder().encode(text))).toEqual({
      path: 'notes/new.md', previousPath: null, status: 'added', binary: false, oversized: false, untracked: true, additions: 2, deletions: 0,
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines }],
    })
  })

  it('describes an empty file without a hunk', () => {
    expect(untrackedFile('empty', new Uint8Array())).toMatchObject({ binary: false, additions: 0, hunks: [] })
  })

  it.each([
    ['a NUL byte', Uint8Array.from([0x61, 0x00, 0x62])],
    ['bytes that are not UTF-8', Uint8Array.from([0xff, 0xfe, 0x61])],
  ])('describes content with %s as binary', (_label, bytes) => {
    expect(untrackedFile('blob', bytes)).toMatchObject({ binary: true, additions: 0, hunks: [] })
  })

  it('looks for a NUL byte only among the first 8000 bytes, as Git does', () => {
    const late = new Uint8Array(8001).fill(0x61)
    late[8000] = 0
    expect(decodeText(late)).toBe(`${'a'.repeat(8000)}\0`)
  })
})

describe('parseNumstat', () => {
  it('reads counts, binary files, and renames whose paths follow in separate fields', () => {
    const output = ['3\t1\tsrc/a.ts', '-\t-\tlogo.png', '0\t0\t', 'old name.txt', 'new\tname.txt', '12\t0\tdocs/中文.md', ''].join('\0')
    expect(parseNumstat(output)).toEqual([
      { path: 'src/a.ts', additions: 3, deletions: 1, binary: false },
      { path: 'logo.png', additions: 0, deletions: 0, binary: true },
      { path: 'new\tname.txt', additions: 0, deletions: 0, binary: false },
      { path: 'docs/中文.md', additions: 12, deletions: 0, binary: false },
    ])
    expect(parseNumstat('')).toEqual([])
  })

  it('ends the list at a rename record that the output limit cut off', () => {
    expect(parseNumstat(['1\t1\ta.ts', '0\t0\t', 'old.txt'].join('\0'))).toEqual([{ path: 'a.ts', additions: 1, deletions: 1, binary: false }])
  })
})
