/**
 * Renders the PR preview's snapshot diff page: one self-contained HTML file
 * listing every changed file under `snapshots/` between two revisions, grouped
 * by scenario directory. The page opens on the SDK blank-Session catalog, the
 * system prompt and tool schemas the `sdk/text-turn` scenario's first request
 * carries, and shows "No change" when neither file changed.
 *
 * Usage: `tsx scripts/snapshot-diff-page.ts --base <rev> --head <rev> --out <file>`
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import * as yaml from 'js-yaml'

/** Scenario whose first request represents a blank SDK Session. */
const CATALOG_SCENARIO = 'snapshots/sdk/text-turn'

/** Per-file and total limits on embedded diff text; the page notes what it omits. */
export interface DiffLimits {
  readonly fileLines: number
  readonly totalChars: number
}

/** Keeps the page well under the Cloudflare Pages 25 MiB per-file limit and responsive in a browser. */
const LIMITS: DiffLimits = { fileLines: 2000, totalChars: 8_000_000 }

/** One `diff --git` section: a changed file and its unified diff text. */
export interface FileDiff {
  /** Repository-relative path. */
  readonly path: string
  /** Unified diff lines from the first `@@` hunk header, empty for binary or mode-only changes. */
  readonly hunks: string
  /** True when git reports a binary change. */
  readonly binary: boolean
  /** Hunk lines left out of `hunks` by the limits. */
  readonly omitted: number
}

/** A selectable group of file diffs on the page. */
export interface DiffGroup {
  readonly title: string
  /** Distinct paths the group covers, including unchanged ones. */
  readonly paths: readonly string[]
  readonly files: readonly FileDiff[]
}

/**
 * Splits git diff output into per-file sections.
 * @param text - Output of `git -c core.quotePath=false diff --no-color --no-renames`;
 *   a path git still quotes (one with `"`, `\\`, or a control character) is rejected.
 * @param limits - Lines kept per file and characters kept across all files.
 * @returns One entry per `diff --git` section, in output order. A path that
 *   changes between symlink and regular file has two sections.
 */
export function parseUnifiedDiff(text: string, limits: DiffLimits = LIMITS): FileDiff[] {
  const files: FileDiff[] = []
  let budget = limits.totalChars
  for (const section of text.split(/^(?=diff --git )/m)) {
    if (!section.startsWith('diff --git ')) continue
    const lines = section.split('\n')
    // Without renames the header is `diff --git a/<path> b/<path>` with both paths equal.
    const header = section.slice('diff --git '.length, section.indexOf('\n') === -1 ? undefined : section.indexOf('\n'))
    if (header.startsWith('"')) throw new Error(`unsupported quoted path in git diff header: ${header}`)
    const path = header.slice('a/'.length, (header.length - ' '.length) / 2)
    const hunkStart = lines.findIndex(line => line.startsWith('@@'))
    const all = hunkStart === -1 ? [] : lines.slice(hunkStart, lines.at(-1) === '' ? -1 : undefined)
    let kept = all.slice(0, limits.fileLines)
    let hunks = kept.join('\n')
    if (hunks.length > budget) {
      kept = []
      hunks = ''
    }
    budget -= hunks.length
    files.push({ path, hunks, binary: lines.some(line => line.startsWith('Binary files ')), omitted: all.length - kept.length })
  }
  return files
}

/**
 * Groups changed files for the page: the catalog first, then one group per
 * scenario directory (`snapshots/<suite>/<scenario>`) in path order.
 * @param files - Changed files under `snapshots/`.
 * @param catalogPaths - Files that make up the SDK blank-Session catalog.
 * @returns The catalog group followed by the scenario groups.
 */
export function groupDiffs(files: readonly FileDiff[], catalogPaths: readonly string[]): DiffGroup[] {
  const scenarios = new Map<string, FileDiff[]>()
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const key = file.path.split('/').slice(0, 3).join('/')
    scenarios.set(key, [...scenarios.get(key) ?? [], file])
  }
  return [
    { title: 'SDK blank Session catalog', paths: catalogPaths, files: files.filter(file => catalogPaths.includes(file.path)) },
    ...[...scenarios].map(([key, group]) => ({ title: key.replace(/^snapshots\//, ''), paths: [...new Set(group.map(file => file.path))], files: group })),
  ]
}

/**
 * Renders the self-contained page.
 * @param groups - Groups from {@link groupDiffs}; the first one opens by default.
 * @param heading - Revision description shown under the title.
 * @returns HTML text.
 */
export function renderSnapshotDiffPage(groups: readonly DiffGroup[], heading: string): string {
  const data = JSON.stringify({ groups, heading }).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Snapshot changes</title>
<style>
:root { color-scheme: light dark; font: 14px/1.45 system-ui, sans-serif; }
body { margin: 0; display: grid; grid-template-columns: minmax(200px, 300px) 1fr; height: 100vh; }
nav { overflow: auto; border-right: 1px solid #8884; padding: 12px 0; }
nav h1 { font-size: 16px; margin: 0 16px 4px; }
nav p { margin: 0 16px 12px; color: #888; font-size: 12px; }
nav button { display: flex; justify-content: space-between; gap: 8px; width: 100%; padding: 6px 16px; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
nav button:hover { background: #8882; }
nav button[aria-current="true"] { background: #4a90e233; font-weight: 600; }
nav button span:last-child { color: #888; font-variant-numeric: tabular-nums; }
nav hr { border: 0; border-top: 1px solid #8884; margin: 8px 0; }
main { overflow: auto; padding: 16px 24px; }
main h2 { font-size: 16px; margin: 0 0 12px; }
section { margin-bottom: 20px; border: 1px solid #8884; border-radius: 6px; overflow: hidden; }
section h3 { font: 600 13px ui-monospace, monospace; margin: 0; padding: 8px 12px; background: #8881; border-bottom: 1px solid #8884; }
pre { margin: 0; font: 12px/1.5 ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
pre div { padding: 0 12px; }
.add { background: #2da44e26; }
.del { background: #cf222e26; }
.hunk { color: #888; background: #8881; }
.empty { padding: 8px 12px; color: #888; }
</style>
</head>
<body>
<nav aria-label="Snapshots"><h1>Snapshot changes</h1><p id="heading"></p><div id="list"></div></nav>
<main id="view"></main>
<script type="application/json" id="data">${data}</script>
<script>
const { groups, heading } = JSON.parse(document.getElementById('data').textContent)
document.getElementById('heading').textContent = heading
const list = document.getElementById('list')
const view = document.getElementById('view')
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}
const buttons = groups.map((group, index) => {
  const button = el('button', { type: 'button', onclick: () => show(index) }, el('span', { textContent: group.title }), el('span', { textContent: String(group.files.length) }))
  list.append(button)
  if (index === 0) list.append(el('hr'))
  return button
})
if (groups.length === 1) list.append(el('p', { textContent: 'No other snapshot changed.' }))
function lineClass(line) {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return ''
}
function render(file) {
  if (file.binary) return [el('div', { className: 'empty', textContent: 'Binary file changed' })]
  const nodes = file.hunks ? [el('pre', {}, ...file.hunks.split('\\n').map(line => el('div', { className: lineClass(line), textContent: line || ' ' })))] : []
  if (file.omitted) nodes.push(el('div', { className: 'empty', textContent: file.omitted + ' more diff lines omitted; see the pull request diff' }))
  return nodes.length ? nodes : [el('div', { className: 'empty', textContent: 'File mode or type changed' })]
}
function show(index) {
  const group = groups[index]
  buttons.forEach((button, i) => button.setAttribute('aria-current', String(i === index)))
  history.replaceState(null, '', '#' + encodeURIComponent(group.title))
  view.replaceChildren(el('h2', { textContent: group.title }))
  for (const path of group.paths) {
    const sections = group.files.filter(candidate => candidate.path === path)
    const bodies = sections.length === 0 ? [el('div', { className: 'empty', textContent: 'No change' })] : sections.flatMap(render)
    view.append(el('section', {}, el('h3', { textContent: path }), ...bodies))
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
 * Reads the catalog files from the catalog scenario's `snapshot.yml`.
 * @param rev - Revision to read.
 * @returns The system prompt sidecar and the tool schema sidecar, which lives
 *   in the scenario named by `header.toolSchemasSource` when present.
 */
function catalogPaths(rev: string): string[] {
  const spec = yaml.load(git('show', `${rev}:${CATALOG_SCENARIO}/snapshot.yml`), { schema: yaml.JSON_SCHEMA }) as { header?: { toolSchemasSource?: unknown } }
  const source = spec.header?.toolSchemasSource
  if (source !== undefined && typeof source !== 'string') throw new Error(`${CATALOG_SCENARIO}/snapshot.yml: header.toolSchemasSource must be a string`)
  const paths = [`${CATALOG_SCENARIO}/system-prompt.expected.md`, `${source === undefined ? CATALOG_SCENARIO : `snapshots/${source}`}/tool-schemas.expected.json`]
  for (const path of paths) {
    try {
      git('cat-file', '-e', `${rev}:${path}`)
    } catch (error) {
      throw new Error(`catalog file ${path} is missing at ${rev}`, { cause: error })
    }
  }
  return paths
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 30 })
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { base: { type: 'string' }, head: { type: 'string' }, out: { type: 'string' } } })
  if (!values.base || !values.head || !values.out) throw new Error('usage: snapshot-diff-page.ts --base <rev> --head <rev> --out <file>')
  const short = (rev: string) => git('rev-parse', '--short', rev).trim()
  const files = parseUnifiedDiff(git('-c', 'core.quotePath=false', 'diff', '--no-color', '--no-renames', '--unified=5', values.base, values.head, '--', 'snapshots/'))
  // A PR that moves the tool schema source shows both the old and the new file.
  const catalog = [...new Set([...catalogPaths(values.base), ...catalogPaths(values.head)])]
  const page = renderSnapshotDiffPage(groupDiffs(files, catalog), `${short(values.base)} → ${short(values.head)}`)
  mkdirSync(dirname(values.out), { recursive: true })
  writeFileSync(values.out, page)
}
