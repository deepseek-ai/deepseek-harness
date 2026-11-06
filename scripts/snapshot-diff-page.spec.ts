import { describe, expect, it } from 'vitest'
import { groupDiffs, parseUnifiedDiff, renderSnapshotDiffPage } from './snapshot-diff-page.ts'

const limits = { fileLines: 100, totalChars: 10_000 }

const diff = `diff --git a/snapshots/sdk/text-turn/system-prompt.expected.md b/snapshots/sdk/text-turn/system-prompt.expected.md
index 1111111..2222222 100644
--- a/snapshots/sdk/text-turn/system-prompt.expected.md
+++ b/snapshots/sdk/text-turn/system-prompt.expected.md
@@ -1,2 +1,2 @@
 You are an agent.
-Old rule.
+New rule.
diff --git a/snapshots/web/ptc-round/session.jsonl b/snapshots/web/ptc-round/session.jsonl
deleted file mode 100644
index 3333333..0000000
--- a/snapshots/web/ptc-round/session.jsonl
+++ /dev/null
@@ -1 +0,0 @@
-{"type":"header"}
diff --git a/snapshots/web/ptc-round/image.png b/snapshots/web/ptc-round/image.png
new file mode 100644
index 0000000..4444444
Binary files /dev/null and b/snapshots/web/ptc-round/image.png differ
diff --git a/snapshots/web/present/workspace.expected/a b/说明.txt b/snapshots/web/present/workspace.expected/a b/说明.txt
old mode 100644
new mode 100755
`

const catalog = ['snapshots/sdk/text-turn/system-prompt.expected.md', 'snapshots/session/text-turn/tool-schemas.expected.json']

describe('snapshot diff page', () => {
  it('splits git diff output into files with their hunks', () => {
    expect(parseUnifiedDiff(diff, limits)).toEqual([
      { path: 'snapshots/sdk/text-turn/system-prompt.expected.md', hunks: '@@ -1,2 +1,2 @@\n You are an agent.\n-Old rule.\n+New rule.', binary: false, omitted: 0 },
      { path: 'snapshots/web/ptc-round/session.jsonl', hunks: '@@ -1 +0,0 @@\n-{"type":"header"}', binary: false, omitted: 0 },
      { path: 'snapshots/web/ptc-round/image.png', hunks: '', binary: true, omitted: 0 },
      { path: 'snapshots/web/present/workspace.expected/a b/说明.txt', hunks: '', binary: false, omitted: 0 },
    ])
    expect(parseUnifiedDiff('', limits)).toEqual([])
  })

  it('rejects paths git still quotes', () => {
    expect(() => parseUnifiedDiff('diff --git "a/snapshots/x\\ty" "b/snapshots/x\\ty"\n', limits)).toThrow('unsupported quoted path')
  })

  it('truncates long files and drops hunks once the total budget is spent', () => {
    const section = (name: string, lines: number) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1,${lines} +1,${lines} @@\n${'+x\n'.repeat(lines - 1)}`
    const [long, fits, over] = parseUnifiedDiff(section('a', 150) + section('b', 10) + section('c', 10), { fileLines: 100, totalChars: 365 })
    expect([long!.hunks.split('\n').length, long!.omitted]).toEqual([100, 50])
    expect([fits!.hunks.split('\n').length, fits!.omitted]).toEqual([10, 0])
    expect([over!.hunks, over!.omitted]).toEqual(['', 10])
  })

  it('opens on the catalog, listing unchanged catalog files, then groups by scenario', () => {
    const groups = groupDiffs(parseUnifiedDiff(diff, limits).slice(0, 3), catalog)
    expect(groups.map(group => [group.title, group.paths, group.files.map(file => file.path)])).toEqual([
      ['SDK blank Session catalog', catalog, ['snapshots/sdk/text-turn/system-prompt.expected.md']],
      ['sdk/text-turn', ['snapshots/sdk/text-turn/system-prompt.expected.md'], ['snapshots/sdk/text-turn/system-prompt.expected.md']],
      ['web/ptc-round', ['snapshots/web/ptc-round/image.png', 'snapshots/web/ptc-round/session.jsonl'], ['snapshots/web/ptc-round/image.png', 'snapshots/web/ptc-round/session.jsonl']],
    ])
  })

  it('lists a path once when a type change splits it into two sections', () => {
    const removed = { path: 'snapshots/acp/cancel/system-prompt.expected.md', hunks: '@@ -1 +0,0 @@\n-../x', binary: false, omitted: 0 }
    const added = { ...removed, hunks: '@@ -0,0 +1 @@\n+text' }
    expect(groupDiffs([removed, added], catalog)[1]).toEqual({ title: 'acp/cancel', paths: [removed.path], files: [removed, added] })
  })

  it('embeds the data so diff text cannot close the script element', () => {
    const page = renderSnapshotDiffPage([{ title: 't', paths: ['p'], files: [{ path: 'p', hunks: '+</script><b>', binary: false, omitted: 0 }] }], 'a → b')
    expect(page).not.toContain('</script><b>')
    const data = /<script type="application\/json" id="data">(.*)<\/script>/.exec(page)![1]!
    expect(JSON.parse(data)).toEqual({ groups: [{ title: 't', paths: ['p'], files: [{ path: 'p', hunks: '+</script><b>', binary: false, omitted: 0 }] }], heading: 'a → b' })
  })
})
