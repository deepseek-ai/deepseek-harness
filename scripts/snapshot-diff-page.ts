/**
 * Renders the PR preview's snapshot diff site: an `index.html` that lists every
 * changed file under `snapshots/` between two revisions, grouped by scenario
 * directory, plus one `files/<n>.json` per file holding its side-by-side diff
 * rows, which the page loads when a group opens. The page opens on the SDK
 * blank-Session catalog, the system prompt and tool schemas the
 * `sdk/text-turn` scenario's first request carries, and shows "No change" for
 * a catalog file whose content is equal on both sides.
 *
 * JSONL files are compared in a readable form: each record becomes a
 * `# <label>` heading followed by its YAML rendering, so long records span
 * several lines and multiline strings, such as prompts and runtime context,
 * appear as text blocks. Records align as units before their lines are
 * compared, so an inserted record shows as one added block.
 *
 * Usage: `tsx scripts/snapshot-diff-page.ts --base <rev> --head <rev> --out <dir> [--preview-manifest <fixtures.json>]`.
 * `--preview-manifest` adds a link to the page in the Preview source chooser.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, relative, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { diffArrays, diffLines, diffWordsWithSpace } from 'diff'
import * as yaml from 'js-yaml'

/** Scenario whose first request represents a blank SDK Session. */
const CATALOG_SCENARIO = 'sdk/text-turn'

/** Limits that keep each per-file data file small enough to load and render. */
export interface DiffLimits {
  /** Unchanged lines kept around each change before the rest collapse. */
  readonly context: number
  /** Rows kept per file, counting each line a collapsed run holds; the page notes how many rows it omits. */
  readonly rows: number
  /** Lines longer than this skip word-level highlighting. */
  readonly wordDiffChars: number
  /** Milliseconds the line diff may take before the file shows as replaced. */
  readonly timeoutMs: number
}

const LIMITS: DiffLimits = { context: 3, rows: 4000, wordDiffChars: 2000, timeoutMs: 5000 }

/** A cell's text, or text segments whose `true` flag marks changed words. */
export type Cell = string | ReadonlyArray<readonly [boolean, string]>

/**
 * One side-by-side row: an unchanged line, a changed pair, a line on one side
 * only, or collapsed unchanged lines that the page can expand.
 */
export type Row =
  | readonly ['same', number, number, string]
  | readonly ['change', number, number, Cell, Cell]
  | readonly ['del', number, string]
  | readonly ['add', number, string]
  | readonly ['skip', number, number, readonly string[]]

/** One changed file in the page index. */
export interface FileEntry {
  readonly path: string
  readonly added: number
  readonly removed: number
  /** Why rows are absent: a binary side, equal content with a changed mode or type, or a diff over the time limit. */
  readonly note?: 'binary' | 'mode' | 'timeout'
}

/** A selectable entry on the page. */
export interface DiffGroup {
  readonly title: string
  /** Distinct {@link FileEntry.path} values the group shows, including unchanged ones. */
  readonly paths: readonly string[]
}

/** The two sidecars that make up a scenario's request catalog. */
export interface CatalogFiles {
  readonly systemPrompt: string
  readonly toolSchemas: string
}

/** Names a record by its `type`, the `params.event.type` of a Session event notification, or its `method`. */
function recordLabel(record: object): string {
  const { type, method, params } = record as { type?: unknown; method?: unknown; params?: { event?: { type?: unknown } } }
  const eventType = params?.event?.type
  if (typeof type === 'string') return type
  if (typeof method === 'string') return typeof eventType === 'string' ? `${method} ${eventType}` : method
  return 'record'
}

/**
 * Splits file content into the units the page aligns before comparing lines.
 * @param path - Repository-relative path; `.jsonl` selects the record view.
 * @param text - File content.
 * @returns The whole content as one unit, or for JSONL one unit per record: a
 *   `# <label>` heading and the record's YAML rendering, ending in a newline. A
 *   line that is not a JSON object stays as written.
 */
export function readableUnits(path: string, text: string): string[] {
  if (!path.endsWith('.jsonl')) return text === '' ? [] : [text]
  return text.split('\n').filter(line => line !== '').map((line) => {
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      // A line that is not JSON is shown unchanged.
      return `${line}\n`
    }
    if (typeof record !== 'object' || record === null || Array.isArray(record)) return `${line}\n`
    return `# ${recordLabel(record)}\n${yaml.dump(record, { lineWidth: -1, noRefs: true })}`
  })
}

interface LineChange {
  readonly value: string
  readonly added?: boolean
  readonly removed?: boolean
}

/**
 * Units count as the same record when they open with the same line, the
 * record label, and at least half of the longer one's lines also occur in the other.
 */
function similar(left: readonly string[], right: readonly string[]): boolean {
  if (left[0] !== right[0]) return false
  const other = new Set(right)
  let shared = 0
  for (const line of new Set(left)) if (other.has(line)) shared++
  return shared * 2 >= Math.max(new Set(left).size, other.size)
}

/**
 * Diffs a run of removed units against a run of added units: units pair up by
 * {@link similar} in order and each pair is diffed line by line, while
 * unpaired units stay whole removals or additions.
 */
function pairedChanges(removed: readonly string[], added: readonly string[], deadline: number): LineChange[] | undefined {
  if (removed.length === 1 && added.length === 1) return diffLines(removed[0] ?? '', added[0] ?? '', { timeout: remaining(deadline) })
  const left = removed.map(unit => unit.split('\n'))
  const right = added.map(unit => unit.split('\n'))
  const indexes = (count: number) => Array.from({ length: count }, (_, index) => index)
  const alignment = diffArrays(indexes(removed.length), indexes(added.length), {
    timeout: remaining(deadline),
    comparator: (a, b) => similar(left[a] ?? [], right[b] ?? []),
  })
  if (alignment === undefined) return undefined
  const changes: LineChange[] = []
  let l = 0
  let r = 0
  for (const part of alignment) {
    for (let step = 0; step < part.count; step++) {
      if (part.removed) changes.push({ value: removed[l++] ?? '', removed: true })
      else if (part.added) changes.push({ value: added[r++] ?? '', added: true })
      else {
        const lines = diffLines(removed[l++] ?? '', added[r++] ?? '', { timeout: remaining(deadline) })
        if (lines === undefined) return undefined
        changes.push(...lines)
      }
    }
  }
  return changes
}

/** Milliseconds left before `deadline`; jsdiff gives up at once when none remain. */
function remaining(deadline: number): number {
  return Math.max(0, deadline - Date.now())
}

/**
 * Aligns whole units first, so an inserted or deleted record stays one block,
 * then diffs lines inside each run of changed units.
 */
function lineChanges(before: readonly string[], after: readonly string[], deadline: number): LineChange[] | undefined {
  const units = diffArrays([...before], [...after], { timeout: remaining(deadline) })
  if (units === undefined) return undefined
  const changes: LineChange[] = []
  for (let index = 0; index < units.length; index++) {
    const unit = units[index]
    const next = units[index + 1]
    if (unit === undefined) continue
    if (unit.removed && next?.added) {
      const paired = pairedChanges(unit.value, next.value, deadline)
      if (paired === undefined) return undefined
      changes.push(...paired)
      index++
    } else {
      changes.push({ value: unit.value.join(''), added: unit.added, removed: unit.removed })
    }
  }
  return changes
}

function linesOf(value: string): string[] {
  const lines = value.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** Joins adjacent unchanged changes so context collapses across unit boundaries. */
function mergeCommon(changes: LineChange[] | undefined): LineChange[] | undefined {
  if (changes === undefined) return undefined
  const merged: LineChange[] = []
  for (const change of changes) {
    const last = merged.at(-1)
    const common = !change.added && !change.removed
    if (common && last !== undefined && !last.added && !last.removed) merged[merged.length - 1] = { value: last.value + change.value }
    else if (change.value !== '') merged.push(change)
  }
  return merged
}

function wordCells(left: string, right: string, limits: DiffLimits): [Cell, Cell] {
  if (left.length > limits.wordDiffChars || right.length > limits.wordDiffChars) return [left, right]
  const parts = diffWordsWithSpace(left, right)
  return [
    parts.filter(part => !part.added).map(part => [part.removed, part.value] as const),
    parts.filter(part => !part.removed).map(part => [part.added, part.value] as const),
  ]
}

/** Rows and line counts for one file; `rows` is absent when the diff timed out. */
export interface SideBySide {
  readonly rows?: Row[]
  readonly added: number
  readonly removed: number
  readonly omitted: number
}

/**
 * Builds side-by-side rows for two unit lists from {@link readableUnits}.
 * Unchanged runs keep `context` lines next to each change and collapse the
 * rest into `skip` rows; removed and added runs pair up line by line as
 * `change` rows with word highlights.
 * @param before - Base units; empty for an added file.
 * @param after - Head units; empty for a deleted file.
 * @param limits - Context, row, word-diff, and time limits.
 * @returns Rows, added and removed line counts, and rows left out by the row
 *   limit, with word highlights only on kept rows; `undefined` rows when the diff exceeded the time limit.
 */
export function sideBySide(before: readonly string[], after: readonly string[], limits: DiffLimits = LIMITS): SideBySide {
  const changes = mergeCommon(lineChanges(before, after, Date.now() + limits.timeoutMs))
  if (changes === undefined) return { added: linesOf(after.join('')).length, removed: linesOf(before.join('')).length, omitted: 0 }
  const rows: Row[] = []
  // A row costs 1, and a skip row also costs the lines it holds.
  let cost = 0
  let omitted = 0
  const push = (row: Row) => {
    const size = row[0] === 'skip' ? 1 + row[3].length : 1
    if (cost + size > limits.rows) omitted++
    else {
      cost += size
      rows.push(row)
    }
  }
  let left = 1
  let right = 1
  let added = 0
  let removed = 0
  for (let index = 0; index < changes.length; index++) {
    const change = changes[index]
    if (change === undefined) continue
    const lines = linesOf(change.value)
    if (!change.added && !change.removed) {
      const head = index === 0 ? 0 : limits.context
      const tail = index === changes.length - 1 ? 0 : limits.context
      if (lines.length <= head + tail + 1) {
        for (const line of lines) push(['same', left++, right++, line])
        continue
      }
      for (const line of lines.slice(0, head)) push(['same', left++, right++, line])
      const hidden = lines.slice(head, lines.length - tail)
      push(['skip', left, right, hidden])
      left += hidden.length
      right += hidden.length
      for (const line of lines.slice(lines.length - tail)) push(['same', left++, right++, line])
      continue
    }
    const next = changes[index + 1]
    const removedLines = change.removed ? lines : []
    const addedLines = change.removed && next?.added ? linesOf(next.value) : change.added ? lines : []
    if (change.removed && next?.added) index++
    removed += removedLines.length
    added += addedLines.length
    for (let line = 0; line < Math.max(removedLines.length, addedLines.length); line++) {
      const before = removedLines[line]
      const after = addedLines[line]
      if (before !== undefined && after !== undefined) push(['change', left++, right++, before, after])
      else if (before !== undefined) push(['del', left++, before])
      else if (after !== undefined) push(['add', right++, after])
    }
  }
  const withWords = rows.map((row): Row => row[0] === 'change' && typeof row[3] === 'string' && typeof row[4] === 'string'
    ? ['change', row[1], row[2], ...wordCells(row[3], row[4], limits)]
    : row)
  return { rows: withWords, added, removed, omitted }
}

/**
 * Groups changed files for the page: the catalog first, then one group per
 * scenario directory (`snapshots/<suite>/<scenario>`) and one per directory
 * holding other changed files, in code point order.
 * @param paths - Changed paths under `snapshots/`.
 * @param catalogPaths - Paths the catalog group shows.
 * @returns The catalog group followed by the directory groups.
 */
export function groupDiffs(paths: readonly string[], catalogPaths: readonly string[]): DiffGroup[] {
  const groups = new Map<string, Set<string>>()
  for (const path of paths) {
    const segments = path.split('/')
    const key = segments.slice(0, segments.length >= 4 ? 3 : -1).join('/')
    groups.set(key, (groups.get(key) ?? new Set()).add(path))
  }
  const byCodePoint = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
  return [
    { title: 'SDK blank Session catalog', paths: catalogPaths },
    ...[...groups].sort(([a], [b]) => byCodePoint(a, b))
      .map(([key, members]) => ({ title: key.replace(/^snapshots\/?/, '') || 'snapshots', paths: [...members].sort(byCodePoint) })),
  ]
}

function referencedScenario(source: unknown, field: string): string {
  if (source === undefined) return CATALOG_SCENARIO
  if (typeof source !== 'string' || source === '') throw new Error(`snapshots/${CATALOG_SCENARIO}/snapshot.yml: header.${field} must be a non-empty string`)
  return source.includes('/') ? source : `${CATALOG_SCENARIO.split('/')[0] ?? ''}/${source}`
}

/**
 * Resolves the catalog sidecars from the catalog scenario's `snapshot.yml`,
 * following `header.systemPromptSource` and `header.toolSchemasSource`; a
 * single-segment source names a scenario in the catalog scenario's suite directory.
 * @param manifestText - The catalog scenario's `snapshot.yml` text.
 * @returns Repository-relative sidecar paths.
 */
export function catalogFiles(manifestText: string): CatalogFiles {
  const manifest = (yaml.load(manifestText, { schema: yaml.JSON_SCHEMA }) ?? {}) as { header?: Record<string, unknown> }
  const header = manifest.header ?? {}
  return {
    systemPrompt: `snapshots/${referencedScenario(header.systemPromptSource, 'systemPromptSource')}/system-prompt.expected.md`,
    toolSchemas: `snapshots/${referencedScenario(header.toolSchemasSource, 'toolSchemasSource')}/tool-schemas.expected.json`,
  }
}

/**
 * Renders the page shell; file rows load from `files/<index>.json`, where the
 * index is the file's position in `files`.
 * @param files - Changed files.
 * @param groups - Groups from {@link groupDiffs}; the first one opens by default.
 * @param heading - Revision description shown under the title.
 * @returns HTML text.
 */
export function renderSnapshotDiffPage(files: readonly FileEntry[], groups: readonly DiffGroup[], heading: string): string {
  const data = JSON.stringify({ files, groups, heading }).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Snapshot changes</title>
<style>
:root { color-scheme: light dark; font: 14px/1.45 system-ui, sans-serif; --line: #8884; --muted: #888; --add: #2da44e26; --add-word: #2da44e66; --del: #cf222e26; --del-word: #cf222e66; }
body { margin: 0; display: grid; grid-template-columns: minmax(200px, 300px) 1fr; height: 100vh; }
nav { overflow: auto; border-right: 1px solid var(--line); padding: 12px 0; }
nav h1 { font-size: 16px; margin: 0 16px 4px; }
nav p { margin: 0 16px 12px; color: var(--muted); font-size: 12px; }
nav button { display: flex; justify-content: space-between; gap: 8px; width: 100%; padding: 6px 16px; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
nav button:hover { background: #8882; }
nav button[aria-current="true"] { background: #4a90e233; font-weight: 600; }
nav hr { border: 0; border-top: 1px solid var(--line); margin: 8px 0; }
.stat { font: 12px ui-monospace, monospace; white-space: nowrap; }
.stat .a { color: #1f883d; } .stat .r { color: #cf222e; }
main { overflow: auto; padding: 16px 24px; }
main h2 { font-size: 16px; margin: 0 0 12px; }
section { margin-bottom: 20px; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
section h3 { display: flex; justify-content: space-between; gap: 12px; font: 600 13px ui-monospace, monospace; margin: 0; padding: 8px 12px; background: #8881; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; font: 12px/1.5 ui-monospace, monospace; }
col.n { width: 4.5em; }
td { vertical-align: top; padding: 0 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
td.n { color: var(--muted); text-align: right; user-select: none; padding-right: 6px; }
td.c + td.n { border-left: 1px solid var(--line); }
td.del { background: var(--del); } td.add { background: var(--add); }
td.del mark { background: var(--del-word); color: inherit; } td.add mark { background: var(--add-word); color: inherit; }
td.none { background: #8881; }
tr.skip td { padding: 2px 12px; color: var(--muted); background: #8881; }
tr.skip button { border: 0; background: none; color: #4a90e2; font: inherit; cursor: pointer; padding: 0; }
.empty { padding: 8px 12px; color: var(--muted); }
@media (max-width: 900px) {
  body { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
  nav { max-height: 30vh; border-right: 0; border-bottom: 1px solid var(--line); }
  main { padding: 12px; }
  col.n { width: 3.5em; }
}
</style>
</head>
<body>
<nav aria-label="Snapshots"><h1>Snapshot changes</h1><p id="heading"></p><div id="list"></div></nav>
<main id="view"></main>
<script type="application/json" id="data">${data}</script>
<script>
const { files, groups, heading } = JSON.parse(document.getElementById('data').textContent)
document.getElementById('heading').textContent = heading
const list = document.getElementById('list')
const view = document.getElementById('view')
const indexOf = new Map(files.map((file, index) => [file.path, index]))
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}
function stat(added, removed) {
  return el('span', { className: 'stat' }, el('span', { className: 'a', textContent: '+' + added }), ' ', el('span', { className: 'r', textContent: '-' + removed }))
}
const buttons = groups.map((group, index) => {
  const changed = group.paths.map(path => files[indexOf.get(path)]).filter(Boolean)
  const button = el('button', { type: 'button', onclick: () => show(index) }, el('span', { textContent: group.title }),
    stat(changed.reduce((sum, file) => sum + file.added, 0), changed.reduce((sum, file) => sum + file.removed, 0)))
  list.append(button)
  if (index === 0) list.append(el('hr'))
  return button
})
if (groups.length === 1) list.append(el('p', { textContent: 'No other snapshot changed.' }))
function cell(value) {
  if (typeof value === 'string') return [value]
  return value.map(([changed, text]) => changed ? el('mark', { textContent: text }) : text)
}
function td(className, ...children) { return el('td', { className }, ...children) }
function rowNodes(row) {
  switch (row[0]) {
    case 'same': return [el('tr', {}, td('n', String(row[1])), td('c', row[3]), td('n', String(row[2])), td('c', row[3]))]
    case 'change': return [el('tr', {}, td('n', String(row[1])), td('c del', ...cell(row[3])), td('n', String(row[2])), td('c add', ...cell(row[4])))]
    case 'del': return [el('tr', {}, td('n', String(row[1])), td('c del', row[2]), td('n'), td('c none'))]
    case 'add': return [el('tr', {}, td('n'), td('c none'), td('n', String(row[1])), td('c add', row[2]))]
    case 'skip': {
      const tr = el('tr', { className: 'skip' })
      const expand = el('button', { type: 'button', textContent: 'Show ' + row[3].length + ' unchanged lines' })
      expand.onclick = () => tr.replaceWith(...row[3].flatMap((line, i) => rowNodes(['same', row[1] + i, row[2] + i, line])))
      tr.append(el('td', { colSpan: 4 }, expand))
      return [tr]
    }
  }
  return []
}
function table(data) {
  const body = el('tbody', {}, ...data.rows.flatMap(rowNodes))
  const node = el('table', {}, el('colgroup', {}, el('col', { className: 'n' }), el('col'), el('col', { className: 'n' }), el('col')), body)
  return data.omitted ? [node, el('div', { className: 'empty', textContent: data.omitted + ' more rows omitted; see the pull request diff' })] : [node]
}
async function fileBody(index) {
  const file = files[index]
  if (file.note === 'binary') return [el('div', { className: 'empty', textContent: 'Binary file changed' })]
  if (file.note === 'mode') return [el('div', { className: 'empty', textContent: 'Only the file mode or type changed' })]
  if (file.note === 'timeout') return [el('div', { className: 'empty', textContent: 'Diff too large to compute; see the pull request diff' })]
  const response = await fetch('files/' + index + '.json')
  if (!response.ok) return [el('div', { className: 'empty', textContent: 'Could not load this diff (' + response.status + ')' })]
  const data = await response.json()
  return table(data)
}
let current = 0
async function show(index) {
  current = index
  const group = groups[index]
  buttons.forEach((button, i) => button.setAttribute('aria-current', String(i === index)))
  history.replaceState(null, '', '#' + encodeURIComponent(group.title))
  view.replaceChildren(el('h2', { textContent: group.title }))
  for (const path of group.paths) {
    const fileIndex = indexOf.get(path)
    const file = files[fileIndex]
    const section = el('section', {}, el('h3', {}, el('span', { textContent: path }), file ? stat(file.added, file.removed) : ''))
    view.append(section)
    if (!file) { section.append(el('div', { className: 'empty', textContent: 'No change' })); continue }
    const body = el('div', { className: 'empty', textContent: 'Loading…' })
    section.append(body)
    fileBody(fileIndex).then(nodes => { if (current === index) body.replaceWith(...nodes) },
      error => { body.textContent = 'Could not load this diff: ' + error })
  }
}
const initial = groups.findIndex(group => '#' + encodeURIComponent(group.title) === location.hash)
show(initial === -1 ? 0 : initial)
</script>
</body>
</html>
`
}

/**
 * Appends a link to the page to a Preview fixture manifest.
 * @param manifestText - `fixtures.json` text the packer wrote.
 * @param href - Page URL relative to the manifest.
 * @returns The updated manifest text.
 */
export function addPreviewLink(manifestText: string, href: string): string {
  const manifest = JSON.parse(manifestText) as { links?: unknown[] }
  return `${JSON.stringify({ ...manifest, links: [...manifest.links ?? [], { label: 'Snapshot changes', href }] }, null, 2)}\n`
}

function git(...args: string[]): Buffer {
  return execFileSync('git', args, { maxBuffer: 1 << 30 })
}

/** Reads a blob, or returns an empty buffer when the path is absent at `rev`. */
function blob(rev: string, path: string): Buffer {
  const entry = git('ls-tree', '-z', rev, '--', path).toString('utf8')
  return entry === '' ? Buffer.alloc(0) : git('cat-file', 'blob', `${rev}:${path}`)
}

/** Requires a regular file, because a symlink blob holds its target path rather than the content it names. */
function assertRegularFile(rev: string, path: string): void {
  const mode = git('ls-tree', rev, '--', path).toString('utf8').split(' ')[0]
  if (mode !== '100644' && mode !== '100755') throw new Error(`catalog file ${path} at ${rev} is not a regular file (mode ${mode || 'missing'})`)
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { 'base': { type: 'string' }, 'head': { type: 'string' }, 'out': { type: 'string' }, 'preview-manifest': { type: 'string' } } })
  const { base, head, out } = values
  if (!base || !head || !out) throw new Error('usage: snapshot-diff-page.ts --base <rev> --head <rev> --out <dir> [--preview-manifest <fixtures.json>]')
  const short = (rev: string) => git('rev-parse', '--short', rev).toString('utf8').trim()
  const changed = git('diff', '-z', '--name-only', '--no-renames', base, head, '--', 'snapshots/').toString('utf8').split('\0').filter(path => path !== '')
  const manifestAt = (rev: string) => catalogFiles(git('show', `${rev}:snapshots/${CATALOG_SCENARIO}/snapshot.yml`).toString('utf8'))
  const from = manifestAt(base)
  const to = manifestAt(head)
  type Side = [rev: string, path: string]
  const pairs: Array<{ path: string; before: Side; after: Side }> = changed
    .map(path => ({ path, before: [base, path], after: [head, path] }))
  const catalog = (['systemPrompt', 'toolSchemas'] as const).map((key) => {
    assertRegularFile(base, from[key])
    assertRegularFile(head, to[key])
    if (from[key] === to[key]) return to[key]
    // The source scenario moved: compare the two files under an `old → new` label.
    const path = `${from[key]} → ${to[key]}`
    if (!blob(base, from[key]).equals(blob(head, to[key]))) pairs.unshift({ path, before: [base, from[key]], after: [head, to[key]] })
    return path
  })
  // Only the outputs this script writes are removed, so a mistaken --out cannot delete other files.
  rmSync(join(out, 'files'), { recursive: true, force: true })
  rmSync(join(out, 'index.html'), { force: true })
  mkdirSync(join(out, 'files'), { recursive: true })
  const files: FileEntry[] = pairs.map(({ path, before, after }, index) => {
    const [left, right] = [blob(...before), blob(...after)]
    if (left.equals(right)) return { path, added: 0, removed: 0, note: 'mode' }
    if (left.includes(0) || right.includes(0)) return { path, added: 0, removed: 0, note: 'binary' }
    const [leftText, rightText] = [left.toString('utf8'), right.toString('utf8')]
    let [leftUnits, rightUnits] = [readableUnits(before[1], leftText), readableUnits(after[1], rightText)]
    // A change the record view drops, such as blank lines, is shown in the raw text.
    if (leftUnits.join('') === rightUnits.join('')) [leftUnits, rightUnits] = [[leftText], [rightText]]
    const result = sideBySide(leftUnits, rightUnits)
    if (result.rows === undefined) return { path, added: result.added, removed: result.removed, note: 'timeout' }
    writeFileSync(join(out, 'files', `${String(index)}.json`), JSON.stringify({ rows: result.rows, omitted: result.omitted }))
    return { path, added: result.added, removed: result.removed }
  })
  writeFileSync(join(out, 'index.html'), renderSnapshotDiffPage(files, groupDiffs(changed, catalog), `${short(base)} → ${short(head)}`))
  const manifest = values['preview-manifest']
  if (manifest) {
    const href = `${relative(dirname(manifest), out).split(sep).join(posix.sep)}/`
    writeFileSync(manifest, addPreviewLink(readFileSync(manifest, 'utf8'), href))
  }
}
