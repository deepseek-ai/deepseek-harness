import { describe, expect, it } from 'vitest'
import { GitLabApi } from '../src/api.ts'
import { comparePatch, fileTextOf, isCommit, mergeBaseOf, newestVersion, textPatch, versionPatch } from '../src/diff.ts'
import type { DiffVersion, ReadText } from '../src/diff.ts'
import { fakeGlab, json, merge, mrPath, output, sha } from './fixtures.ts'

const signal = new AbortController().signal

function version(overrides: Partial<DiffVersion> = {}): DiffVersion {
  return { id: 41, head_commit_sha: sha('a'), base_commit_sha: sha('b'), start_commit_sha: sha('c'), real_size: '3', ...overrides }
}

/** One changed file as GitLab lists it, modified in place by default. */
function file(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    old_path: 'src/a.ts', new_path: 'src/a.ts', a_mode: '100644', b_mode: '100644', new_file: false, renamed_file: false, deleted_file: false,
    diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n', ...overrides,
  }
}

const noText: ReadText = async () => { throw new Error('not read') }

describe('GitLab diff versions', () => {
  it('finds the newest version at the expected head', async () => {
    const glab = fakeGlab(() => json([version()]))
    await expect(newestVersion(new GitLabApi(glab.run), merge(6), sha('A'), signal)).resolves.toEqual(version())
    expect(glab.calls[0]?.args.at(-1)).toBe(`${mrPath(6)}/versions?per_page=1`)
  })

  it.each([
    [json([version({ head_commit_sha: sha('d') })]), { code: 'stale', message: `the merge request head moved from ${sha('a')} to ${sha('d')}` }],
    [json([]), { code: 'stale', message: 'merge request 6 has no diff version yet' }],
    [json({ message: 'nope' }), { code: 'unavailable', message: 'unexpected GitLab response to the diff version listing' }],
    [output('', 1, 'glab: (HTTP 404)'), { code: 'not-found', message: '(HTTP 404)' }],
  ])('reports a version listing that does not name the head', async (answer, failure) => {
    await expect(newestVersion(new GitLabApi(fakeGlab(() => answer).run), merge(6), sha('a'), signal)).resolves.toEqual(failure)
  })

  it('joins files ordered by path with Git headers for new, deleted, renamed, and mode-changed files', async () => {
    const glab = fakeGlab(() => json({ diffs: [
      file({ old_path: 'z.sh', new_path: 'z.sh', a_mode: '100644', b_mode: '100755', diff: '' }),
      file({ old_path: 'b/new.ts', new_path: 'b/new.ts', new_file: true, a_mode: '0', b_mode: '100644', diff: '--- /dev/null\n+++ b/b/new.ts\n@@ -0,0 +1 @@\n+x' }),
      file({ old_path: 'b/gone.ts', new_path: 'b/gone.ts', deleted_file: true, a_mode: '100644', b_mode: '0', diff: '--- a/b/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n' }),
      file({ old_path: 'old.md', new_path: 'new.md', renamed_file: true, diff: '' }),
      file({ a_mode: null, b_mode: null }),
      file({ old_path: 'n.ts', new_path: 'n.ts', new_file: true, b_mode: null, diff: '' }),
      file({ old_path: 'd.ts', new_path: 'd.ts', deleted_file: true, a_mode: null, diff: '' }),
    ] }))
    await expect(versionPatch(new GitLabApi(glab.run), merge(6), version(), noText, signal)).resolves.toBe([
      'diff --git a/b/gone.ts b/b/gone.ts\ndeleted file mode 100644\n--- a/b/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n',
      'diff --git a/b/new.ts b/b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/b/new.ts\n@@ -0,0 +1 @@\n+x\n',
      'diff --git a/d.ts b/d.ts\ndeleted file mode 100644\n',
      'diff --git a/n.ts b/n.ts\nnew file mode 100644\n',
      'diff --git a/old.md b/new.md\nrename from old.md\nrename to new.md\n',
      'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
      'diff --git a/z.sh b/z.sh\nold mode 100644\nnew mode 100755\n',
    ].join(''))
    expect(glab.calls[0]?.args.at(-1)).toBe(`${mrPath(6)}/versions/41?unidiff=true`)
  })

  it('keeps GitLab\'s order for entries that name the same paths', async () => {
    const glab = fakeGlab(() => json({ diffs: [file({ diff: '+first\n' }), file({ diff: '+second\n' })] }))
    await expect(versionPatch(new GitLabApi(glab.run), merge(6), version(), noText, signal))
      .resolves.toBe('diff --git a/src/a.ts b/src/a.ts\n+first\ndiff --git a/src/a.ts b/src/a.ts\n+second\n')
  })

  it('compares a file GitLab collapsed from its text at both commits', async () => {
    const texts = new Map([[`${sha('b')}:src/a.ts`, 'a\nb\nc\n'], [`${sha('a')}:src/a.ts`, 'a\nB\nc\n'], [`${sha('a')}:img.png`, 'P\0NG'], [`${sha('a')}:added.ts`, 'x\n']])
    const read: ReadText = async (commit, path) => texts.get(`${commit}:${path}`) ?? { code: 'not-found', message: path }
    const glab = fakeGlab(() => json({ diffs: [
      file({ diff: '', collapsed: true }),
      file({ old_path: 'img.png', new_path: 'img.png', new_file: true, diff: '', too_large: true }),
      file({ old_path: 'added.ts', new_path: 'added.ts', new_file: true, diff: '', collapsed: true }),
    ] }))
    await expect(versionPatch(new GitLabApi(glab.run), merge(6), version(), read, signal)).resolves.toBe([
      'diff --git a/added.ts b/added.ts\nnew file mode 100644\n--- /dev/null\n+++ b/added.ts\n@@ -0,0 +1,1 @@\n+x\n',
      'diff --git a/img.png b/img.png\nnew file mode 100644\nBinary files /dev/null and b/img.png differ\n',
      'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n',
    ].join(''))
  })

  it('passes on a file read that fails on either side', async () => {
    const failing = (side: string): ReadText => async commit => commit === side ? { code: 'unavailable', message: side } : 'x'
    const glab = fakeGlab(() => json({ diffs: [file({ diff: '', collapsed: true })] }))
    await expect(versionPatch(new GitLabApi(glab.run), merge(6), version(), failing(sha('b')), signal)).resolves.toEqual({ code: 'unavailable', message: sha('b') })
    await expect(versionPatch(new GitLabApi(glab.run), merge(6), version(), failing(sha('a')), signal)).resolves.toEqual({ code: 'unavailable', message: sha('a') })
    const deleted = fakeGlab(() => json({ diffs: [file({ deleted_file: true, diff: '', collapsed: true })] }))
    await expect(versionPatch(new GitLabApi(deleted.run), merge(6), version(), async () => 'x\n', signal)).resolves.toBe(
      'diff --git a/src/a.ts b/src/a.ts\ndeleted file mode 100644\n--- a/src/a.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n')
  })

  it('refuses a version over GitLab\'s file limit, and passes on failed and unexpected reads', async () => {
    await expect(versionPatch(new GitLabApi(fakeGlab(() => json({})).run), merge(6), version({ real_size: '1000+' }), noText, signal))
      .resolves.toEqual({ code: 'too-large', message: 'merge request 6 changes more files than GitLab lists' })
    await expect(versionPatch(new GitLabApi(fakeGlab(() => json({})).run), merge(6), version({ real_size: null }), noText, signal))
      .resolves.toEqual({ code: 'unavailable', message: 'unexpected GitLab response to the diff version' })
    await expect(versionPatch(new GitLabApi(fakeGlab(() => output('', 1, 'glab: (HTTP 500)')).run), merge(6), version(), noText, signal))
      .resolves.toEqual({ code: 'unavailable', message: '(HTTP 500)' })
  })
})

describe('GitLab comparisons', () => {
  it('compares two commits of the project', async () => {
    const glab = fakeGlab(() => json({ diffs: [file()], compare_timeout: false }))
    await expect(comparePatch(new GitLabApi(glab.run), merge(6), sha('b'), sha('a'), noText, signal))
      .resolves.toBe('diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n')
    expect(glab.calls[0]?.args.at(-1)).toBe(`projects/group%2Fsub%2Fapp/repository/compare?from=${sha('b')}&to=${sha('a')}&unidiff=true`)
  })

  it.each([
    [json({ diffs: [], compare_timeout: true }), { code: 'too-large', message: `GitLab stopped comparing ${sha('b')} with ${sha('a')}` }],
    [json({ commits: [] }), { code: 'unavailable', message: 'unexpected GitLab response to the comparison' }],
    [output('', 1, 'glab: (HTTP 404)'), { code: 'not-found', message: '(HTTP 404)' }],
  ])('reports a comparison GitLab did not complete', async (answer, failure) => {
    await expect(comparePatch(new GitLabApi(fakeGlab(() => answer).run), merge(6), sha('b'), sha('a'), noText, signal)).resolves.toEqual(failure)
  })

  it('reads merge bases and file texts', async () => {
    const glab = fakeGlab(path => path.includes('merge_base') ? json({ id: sha('c') }) : output('text'))
    const api = new GitLabApi(glab.run)
    await expect(mergeBaseOf(api, merge(6), sha('b'), sha('a'), signal)).resolves.toBe(sha('c'))
    expect(glab.calls[0]?.args.at(-1)).toBe(`projects/group%2Fsub%2Fapp/repository/merge_base?refs[]=${sha('b')}&refs[]=${sha('a')}`)
    await expect(fileTextOf(api, merge(6), sha('a'), 'docs/a b.md', signal)).resolves.toBe('text')
    expect(glab.calls[1]?.args.at(-1)).toBe(`projects/group%2Fsub%2Fapp/repository/files/docs%2Fa%20b.md/raw?ref=${sha('a')}`)
  })

  it.each([
    [json({ id: 'abc' }), { code: 'unavailable', message: 'GitLab named no full merge base commit' }],
    [json({}), { code: 'unavailable', message: 'GitLab named no full merge base commit' }],
    [output('', 1, 'glab: (HTTP 400)'), { code: 'unavailable', message: '(HTTP 400)' }],
  ])('reports a merge base GitLab did not name', async (answer, failure) => {
    await expect(mergeBaseOf(new GitLabApi(fakeGlab(() => answer).run), merge(6), sha('b'), sha('a'), signal)).resolves.toEqual(failure)
  })

  it('checks full commit names and compares texts', () => {
    expect(isCommit(sha('a'))).toBe(true)
    expect(isCommit('f'.repeat(64))).toBe(true)
    expect(isCommit('abc')).toBe(false)
    expect(textPatch('a/x', 'b/x', 'same\n', 'same\n')).toBe('--- a/x\n+++ b/x\n')
  })
})
