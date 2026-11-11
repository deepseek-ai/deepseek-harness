import { describe, expect, it } from 'vitest'
import { addPreviewLink, catalogFiles, groupDiffs, readableUnits, renderSnapshotDiffPage, sideBySide } from './snapshot-diff-page.ts'

const limits = { context: 1, rows: 100, wordDiffChars: 100, timeoutMs: 5000 }
const text = (...lines: string[]) => [lines.map(line => `${line}\n`).join('')]

describe('snapshot diff page', () => {
  it('renders JSONL records as labelled YAML blocks and keeps other files whole', () => {
    const jsonl = [
      '{"type":"user/message","data":{"text":"a\\nb"}}',
      '{"method":"session.event","params":{"event":{"type":"turn/start"}}}',
      '{"method":"ping"}',
      '[1]',
      'not json',
      '',
    ].join('\n')
    expect(readableUnits('s/session.jsonl', jsonl)).toEqual([
      '# user/message\ntype: user/message\ndata:\n  text: |-\n    a\n    b\n',
      '# session.event turn/start\nmethod: session.event\nparams:\n  event:\n    type: turn/start\n',
      '# ping\nmethod: ping\n',
      '[1]\n',
      'not json\n',
    ])
    expect(readableUnits('s/prompt.md', 'a\nb')).toEqual(['a\nb'])
    expect(readableUnits('s/prompt.md', '')).toEqual([])
  })

  it('collapses unchanged runs beyond the context and pairs changed lines with word highlights', () => {
    const result = sideBySide(text('a', 'b', 'c', 'd', 'old word', 'e', 'f', 'g'), text('a', 'b', 'c', 'd', 'new word', 'e', 'added', 'f', 'g'), limits)
    expect(result).toEqual({
      added: 2, removed: 1, omitted: 0,
      rows: [
        ['skip', 1, 1, ['a', 'b', 'c']],
        ['same', 4, 4, 'd'],
        ['change', 5, 5, [[true, 'old'], [false, ' word']], [[true, 'new'], [false, ' word']]],
        ['same', 6, 6, 'e'],
        ['add', 7, 'added'],
        ['same', 7, 8, 'f'],
        ['same', 8, 9, 'g'],
      ],
    })
  })

  it('shows unmatched removed lines and leaves long lines without word highlights', () => {
    const long = 'x'.repeat(101)
    expect(sideBySide(text(long, 'gone', 'z'), text(`${long}!`, 'z'), limits).rows).toEqual([
      ['change', 1, 1, long, `${long}!`],
      ['del', 2, 'gone'],
      ['same', 3, 2, 'z'],
    ])
  })

  it('keeps an inserted JSONL record as one added block when later records also change', () => {
    const record = (type: string, seq: number) => `{"type":"${type}","seq":${String(seq)},"a":1,"b":2,"c":3}`
    const before = readableUnits('x.jsonl', [record('one', 1), record('three', 2)].join('\n'))
    const after = readableUnits('x.jsonl', [record('one', 1), record('two', 2), record('three', 3)].join('\n'))
    const rows = sideBySide(before, after, { ...limits, context: 0 }).rows ?? []
    expect(rows.filter(row => row[0] === 'add').map(row => row[2])).toEqual(['# two', 'type: two', 'seq: 2', 'a: 1', 'b: 2', 'c: 3'])
    expect(rows.filter(row => row[0] === 'change')).toEqual([['change', 9, 15, [[false, 'seq: '], [true, '2']], [[false, 'seq: '], [true, '3']]]])
  })

  it('reports omitted rows past the limit and no rows when the diff times out', () => {
    const many = Array.from({ length: 10 }, (_, index) => `line ${String(index)}`)
    expect(sideBySide([], text(...many), { ...limits, rows: 4 })).toMatchObject({ added: 10, removed: 0, omitted: 6 })
    expect(sideBySide([], text(...many), { ...limits, rows: 4 }).rows).toHaveLength(4)
    // The skip row holds lines 1–7 and costs 8, so only it and the next row fit in 9.
    const collapsed = sideBySide(text('1', '2', '3', '4', '5', '6', '7', '8', 'old', '9'), text('1', '2', '3', '4', '5', '6', '7', '8', 'new', '9'), { ...limits, rows: 9 })
    expect([collapsed.rows?.map(row => row[0]), collapsed.omitted]).toEqual([['skip', 'same'], 2])
    const big = Array.from({ length: 4000 }, (_, index) => String(index))
    expect(sideBySide(text(...big), text(...big.toReversed()), { ...limits, timeoutMs: 0 }))
      .toEqual({ added: 4000, removed: 4000, omitted: 0 })
  })

  it('opens on the catalog, then groups scenarios and other files by directory in code point order', () => {
    const catalog = ['snapshots/sdk/text-turn/system-prompt.expected.md', 'snapshots/session/text-turn/tool-schemas.expected.json']
    const paths = ['snapshots/web/b/x', 'snapshots/sdk/sdk.snapshot.ts', 'snapshots/AGENTS.md', 'snapshots/web/B/x', 'snapshots/web/b/a/y']
    expect(groupDiffs(paths, catalog)).toEqual([
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
  ])('resolves catalog sidecars when the manifest %s', (_, manifest, prompt, schemas) => {
    expect(catalogFiles(manifest)).toEqual({
      systemPrompt: `snapshots/${prompt}/system-prompt.expected.md`,
      toolSchemas: `snapshots/${schemas}/tool-schemas.expected.json`,
    })
  })

  it.each([
    ['a non-string source', 'profile: sdk\nheader:\n  toolSchemasSource: 1\n', 'header.toolSchemasSource must be a non-empty string'],
    ['an empty source', 'header:\n  systemPromptSource: ""\n', 'header.systemPromptSource must be a non-empty string'],
  ])('rejects %s', (_, manifest, message) => {
    expect(() => catalogFiles(manifest)).toThrow(message)
  })

  it('embeds the index so a path cannot close the script element', () => {
    const files = [{ path: 'p</script><b>', added: 1, removed: 0 }]
    const groups = [{ title: 't', paths: ['p</script><b>'] }]
    const page = renderSnapshotDiffPage(files, groups, 'a → b')
    expect(page).not.toContain('</script><b>')
    const data = /<script type="application\/json" id="data">(.*)<\/script>/.exec(page)?.[1] ?? ''
    expect(JSON.parse(data)).toEqual({ files, groups, heading: 'a → b' })
  })

  it('appends the page link to the Preview fixture manifest', () => {
    const manifest = JSON.stringify({ version: 1, defaultFixture: null, fixtures: [] })
    expect(JSON.parse(addPreviewLink(manifest, '../snapshot-diff/'))).toEqual({
      version: 1, defaultFixture: null, fixtures: [], links: [{ label: 'Snapshot changes', href: '../snapshot-diff/' }],
    })
  })
})
