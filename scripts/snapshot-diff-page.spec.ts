import { describe, expect, it } from 'vitest'
import { addPreviewLink, catalogFiles, groupDiffs, limitDiffs, parseUnifiedDiff, renderSnapshotDiffPage } from './snapshot-diff-page.ts'

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

const file = (path: string, hunks = '') => ({ path, hunks, binary: false, omitted: 0 })

describe('snapshot diff page', () => {
  it('splits git diff output into files with their hunks', () => {
    expect(parseUnifiedDiff(diff)).toEqual([
      file('snapshots/sdk/text-turn/system-prompt.expected.md', '@@ -1,2 +1,2 @@\n You are an agent.\n-Old rule.\n+New rule.'),
      file('snapshots/web/ptc-round/session.jsonl', '@@ -1 +0,0 @@\n-{"type":"header"}'),
      { ...file('snapshots/web/ptc-round/image.png'), binary: true },
      file('snapshots/web/present/workspace.expected/a b/说明.txt'),
    ])
    expect(parseUnifiedDiff('')).toEqual([])
  })

  it.each([
    ['a quoted path', 'diff --git "a/snapshots/x\\ty" "b/snapshots/x\\ty"\n'],
    ['unequal header paths', 'diff --git a/snapshots/x b/snapshots/y\n'],
    ['a missing prefix', 'diff --git snapshots/x snapshots/x\n'],
  ])('rejects a header with %s', (_, text) => {
    expect(() => parseUnifiedDiff(text)).toThrow('unsupported git diff header')
  })

  it('truncates long sections and drops sections past the byte budget of the escaped JSON', () => {
    const lines = (count: number, line = '+x') => file(`f${count}`, ['@@', ...Array.from({ length: count - 1 }, () => line)].join('\n'))
    const [long, fits, over] = limitDiffs([lines(150), lines(10), lines(10)], { fileLines: 100, totalBytes: 445 })
    expect([long?.hunks.split('\n').length, long?.omitted]).toEqual([100, 50])
    expect([fits?.hunks.split('\n').length, fits?.omitted]).toEqual([10, 0])
    expect([over?.hunks, over?.omitted]).toEqual(['', 10])
    // Quotes, `@@`, and nine lines of an escaped newline, `+`, and two six-byte \u003c escapes: 139 bytes.
    expect(limitDiffs([lines(10, '+<<')], { fileLines: 100, totalBytes: 138 })[0]?.omitted).toBe(10)
    expect(limitDiffs([lines(10, '+<<')], { fileLines: 100, totalBytes: 139 })[0]?.omitted).toBe(0)
  })

  it('opens on the catalog, then groups scenarios and other files by directory in code point order', () => {
    const catalog = ['snapshots/sdk/text-turn/system-prompt.expected.md', 'snapshots/session/text-turn/tool-schemas.expected.json']
    const paths = ['snapshots/web/b/x', 'snapshots/sdk/sdk.snapshot.ts', 'snapshots/AGENTS.md', 'snapshots/web/B/x', 'snapshots/web/b/a/y']
    expect(groupDiffs([...paths, 'snapshots/web/b/x'].map(path => file(path)), catalog)).toEqual([
      { title: 'SDK blank Session catalog', paths: catalog },
      { title: 'snapshots', paths: ['snapshots/AGENTS.md'] },
      { title: 'sdk', paths: ['snapshots/sdk/sdk.snapshot.ts'] },
      { title: 'web/B', paths: ['snapshots/web/B/x'] },
      { title: 'web/b', paths: ['snapshots/web/b/a/y', 'snapshots/web/b/x'] },
    ])
  })

  it.each([
    ['owns both sidecars', 'profile: sdk\n', 'sdk/text-turn', 'sdk/text-turn'],
    ['names a source in its own suite directory', 'profile: sdk-minimal\nheader:\n  toolSchemasSource: other\n', 'sdk/text-turn', 'sdk/other'],
    ['names sources in another suite', 'profile: sdk\nheader:\n  systemPromptSource: session/a\n  toolSchemasSource: session/b\n', 'session/a', 'session/b'],
  ])('resolves catalog sidecars when the manifest %s', (_, text, prompt, schemas) => {
    expect(catalogFiles(text)).toEqual({
      systemPrompt: `snapshots/${prompt}/system-prompt.expected.md`,
      toolSchemas: `snapshots/${schemas}/tool-schemas.expected.json`,
    })
  })

  it.each([
    ['a non-string source', 'profile: sdk\nheader:\n  toolSchemasSource: 1\n', 'header.toolSchemasSource must be a non-empty string'],
    ['an empty source', 'header:\n  systemPromptSource: ""\n', 'header.systemPromptSource must be a non-empty string'],
  ])('rejects %s', (_, text, message) => {
    expect(() => catalogFiles(text)).toThrow(message)
  })

  it('embeds the data so diff text cannot close the script element', () => {
    const files = [file('p', '+</script><b>')]
    const page = renderSnapshotDiffPage(files, [{ title: 't', paths: ['p'] }], 'a → b')
    expect(page).not.toContain('</script><b>')
    const data = /<script type="application\/json" id="data">(.*)<\/script>/.exec(page)?.[1] ?? ''
    expect(JSON.parse(data)).toEqual({ files, groups: [{ title: 't', paths: ['p'] }], heading: 'a → b' })
  })

  it('appends the page link to the Preview fixture manifest', () => {
    const manifest = JSON.stringify({ version: 1, defaultFixture: null, fixtures: [] })
    expect(JSON.parse(addPreviewLink(manifest, '../snapshot-diff/'))).toEqual({
      version: 1, defaultFixture: null, fixtures: [], links: [{ label: 'Snapshot changes', href: '../snapshot-diff/' }],
    })
  })
})
