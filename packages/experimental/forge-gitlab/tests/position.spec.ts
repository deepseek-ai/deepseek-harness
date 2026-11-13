import { createHash } from 'node:crypto'
import type { ForgeLineComment } from '@deepseek-ai/dsh-experimental-forge'
import { describe, expect, it } from 'vitest'
import { textPosition } from '../src/position.ts'
import type { VersionFile } from '../src/position.ts'
import { sha } from './fixtures.ts'

const version = { base: sha('b'), start: sha('c'), head: sha('a') }
const code = (path: string, oldPos: number, newPos: number): string => `${createHash('sha1').update(path).digest('hex')}_${oldPos}_${newPos}`

/** The diff GitLab recorded for a file that changes lines 5-6, deletes line 20, and inserts a line after line 30. */
const changed: VersionFile = {
  oldPath: 'src/app.js', newPath: 'src/app.js', diff: [
    '--- a/src/app.js', '+++ b/src/app.js',
    '@@ -2,8 +2,8 @@ export const value1 = 1', ' v2', ' v3', ' v4', '-v5', '-v6', '+five', '+six', ' v7', ' v8', ' v9',
    '@@ -17,7 +17,6 @@ export const value16 = 16', ' v17', ' v18', ' v19', '-v20', ' v21', ' v22', ' v23',
    '@@ -28,6 +27,7 @@ export const value27 = 27', ' v28', ' v29', ' v30', '+inserted', ' v31', ' v32', ' v33', '\\ No newline at end of file',
  ].join('\n'),
}

const comment = (side: 'L' | 'R', startLine: number, endLine = startLine): ForgeLineComment => ({ path: 'src/app.js', side, startLine, endLine, body: 'x' })

describe('GitLab diff note positions', () => {
  it('names the version, the paths, and an added line by its new line', () => {
    expect(textPosition(version, changed, comment('R', 6))).toEqual({
      position_type: 'text', base_sha: sha('b'), start_sha: sha('c'), head_sha: sha('a'), old_path: 'src/app.js', new_path: 'src/app.js',
      old_line: null, new_line: 6,
    })
  })

  it.each([
    ['a deleted line', 'L', 20, 20, null],
    ['an unchanged line on the new side', 'R', 4, 4, 4],
    ['an unchanged line on the old side', 'L', 22, 22, 21],
    ['a line between hunks', 'R', 12, 12, 12],
    ['a line after a deletion and before an insertion', 'R', 26, 27, 26],
    ['a line after the last hunk', 'R', 38, 38, 38],
    ['an old line after the last hunk', 'L', 38, 38, 38],
    ['a line before the first hunk', 'R', 1, 1, 1],
  ] as const)('numbers %s on both sides', (_label, side, line, oldLine, newLine) => {
    const position = textPosition(version, changed, comment(side, line))
    expect(position).toMatchObject({ old_line: oldLine, new_line: newLine })
  })

  it('places a range at its last line with both ends and their line codes', () => {
    expect(textPosition(version, changed, comment('R', 3, 6))).toMatchObject({
      old_line: null, new_line: 6,
      line_range: {
        start: { type: null, old_line: 3, new_line: 3, line_code: code('src/app.js', 3, 3) },
        end: { type: 'new', old_line: null, new_line: 6, line_code: code('src/app.js', 7, 6) },
      },
    })
    expect(textPosition(version, changed, comment('L', 4, 6))).toMatchObject({
      old_line: 6, new_line: null,
      line_range: { start: { type: null, old_line: 4, new_line: 4 }, end: { type: 'old', old_line: 6, new_line: null, line_code: code('src/app.js', 6, 5) } },
    })
  })

  it('numbers an added file from an empty old side and hashes a renamed file by its new path', () => {
    const added: VersionFile = { oldPath: 'new.js', newPath: 'new.js', diff: '--- /dev/null\n+++ b/new.js\n@@ -0,0 +1,2 @@\n+a\n+b\n' }
    expect(textPosition(version, added, comment('R', 1, 2))).toMatchObject({
      line_range: { start: { line_code: code('new.js', 0, 1) }, end: { type: 'new', new_line: 2, line_code: code('new.js', 0, 2) } },
    })
    const deleted: VersionFile = { oldPath: 'gone.js', newPath: 'gone.js', diff: '@@ -1,2 +0,0 @@\n-a\n-b\n' }
    expect(textPosition(version, deleted, comment('L', 2))).toMatchObject({ old_line: 2, new_line: null })
    const renamed: VersionFile = { oldPath: 'old.js', newPath: 'new.js', diff: '@@ -1,2 +1,2 @@\n a\n-b\n+c\n' }
    expect(textPosition(version, renamed, { ...comment('R', 1, 2), path: 'new.js' })).toMatchObject({
      old_path: 'old.js', new_path: 'new.js', line_range: { start: { line_code: code('new.js', 1, 1) } },
    })
  })

  it('places no comment on a line before 1 or in a diff it cannot parse', () => {
    expect(textPosition(version, changed, comment('R', 0))).toBeUndefined()
    expect(textPosition(version, changed, comment('R', 0, 3))).toBeUndefined()
    expect(textPosition(version, { ...changed, diff: '@@ -1,5 +1,5 @@\n a\n@@ -9 +9 @@\n b\n' }, comment('R', 1))).toBeUndefined()
  })
})
