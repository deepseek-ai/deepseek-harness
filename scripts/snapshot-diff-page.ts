/**
 * Renders the PR preview's snapshot diff page: one self-contained HTML file
 * listing every changed file under `snapshots/` between two revisions, grouped
 * by scenario directory. The page opens on the SDK blank-Session catalog, the
 * system prompt and tool schemas the `sdk/text-turn` scenario's first request
 * carries, and shows "No change" for a catalog file whose content is equal on
 * both sides.
 *
 * Usage: `tsx scripts/snapshot-diff-page.ts --base <rev> --head <rev> --out <file> [--preview-manifest <fixtures.json>]`.
 * `--preview-manifest` adds a link to the page in the Preview source chooser.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, posix, relative, sep } from 'node:path'
import { parseArgs } from 'node:util'
import * as yaml from 'js-yaml'

/** Scenario whose first request represents a blank SDK Session. */
const CATALOG_SCENARIO = 'sdk/text-turn'

/** Limits on embedded diff text; the page notes how many lines it omits. */
export interface DiffLimits {
  /** Hunk lines kept per diff section. */
  readonly fileLines: number
  /** UTF-8 bytes of escaped JSON hunk text kept across the page. */
  readonly totalBytes: number
}

/** Keeps the page well under the Cloudflare Pages 25 MiB per-file limit. */
const LIMITS: DiffLimits = { fileLines: 2000, totalBytes: 20 * 1024 * 1024 }

/** One `diff --git` section: a changed file and its unified diff text. */
export interface FileDiff {
  /** Repository-relative path, or `old → new` for a catalog file whose source scenario changed. */
  readonly path: string
  /** Unified diff lines from the first `@@` hunk header, empty for binary or mode-only changes. */
  readonly hunks: string
  /** True when git reports a binary change. */
  readonly binary: boolean
  /** Hunk lines left out of `hunks` by the limits. */
  readonly omitted: number
}

/** A selectable entry on the page. */
export interface DiffGroup {
  readonly title: string
  /** Distinct {@link FileDiff.path} values the group shows, including unchanged ones. */
  readonly paths: readonly string[]
}

/** The two sidecars that make up a scenario's request catalog. */
export interface CatalogFiles {
  readonly systemPrompt: string
  readonly toolSchemas: string
}

function hunksOf(lines: readonly string[]): string[] {
  const start = lines.findIndex(line => line.startsWith('@@'))
  return start === -1 ? [] : lines.slice(start, lines.at(-1) === '' ? -1 : undefined)
}

function section(path: string, lines: readonly string[]): FileDiff {
  const hunks = hunksOf(lines)
  return { path, hunks: hunks.join('\n'), binary: lines.some(line => line.startsWith('Binary files ')), omitted: 0 }
}

/**
 * Splits git diff output into per-file sections.
 * @param text - Output of `git -c core.quotePath=false diff --no-color --no-renames --no-ext-diff --src-prefix=a/ --dst-prefix=b/`.
 * @returns One untruncated entry per `diff --git` section, in output order. A
 *   path that changes between symlink and regular file has two sections.
 * @throws When a header does not read `diff --git a/<path> b/<path>`, as for a
 *   path git still quotes (one with `"`, `\\`, or a control character).
 */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = []
  for (const part of text.split(/^(?=diff --git )/m)) {
    if (!part.startsWith('diff --git ')) continue
    const lines = part.split('\n')
    const header = /^diff --git a\/(.+) b\/\1$/.exec(lines[0] ?? '')
    if (header?.[1] === undefined) throw new Error(`unsupported git diff header: ${lines[0] ?? ''}`)
    files.push(section(header[1], lines))
  }
  return files
}

function embeddedBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text).replace(/</g, '\\u003c'))
}

/**
 * Applies the limits in order: each section keeps at most `fileLines` hunk
 * lines, and a section that would exceed the remaining byte budget keeps none.
 * @param files - Sections in page order.
 * @param limits - Per-section line and page byte limits.
 * @returns Sections with `hunks` cut and `omitted` counting the dropped lines.
 */
export function limitDiffs(files: readonly FileDiff[], limits: DiffLimits = LIMITS): FileDiff[] {
  let budget = limits.totalBytes
  return files.map((file) => {
    const all = file.hunks === '' ? [] : file.hunks.split('\n')
    let hunks = all.slice(0, limits.fileLines).join('\n')
    if (embeddedBytes(hunks) > budget) hunks = ''
    budget -= embeddedBytes(hunks)
    const kept = hunks === '' ? 0 : Math.min(all.length, limits.fileLines)
    return { ...file, hunks, omitted: all.length - kept }
  })
}

/**
 * Groups changed files for the page: the catalog first, then one group per
 * scenario directory (`snapshots/<suite>/<scenario>`) and one per directory
 * holding other changed files, in code point order.
 * @param files - Changed files under `snapshots/`.
 * @param catalogPaths - Paths the catalog group shows.
 * @returns The catalog group followed by the directory groups.
 */
export function groupDiffs(files: readonly FileDiff[], catalogPaths: readonly string[]): DiffGroup[] {
  const groups = new Map<string, Set<string>>()
  for (const { path } of files) {
    const segments = path.split('/')
    const key = segments.slice(0, segments.length >= 4 ? 3 : -1).join('/')
    groups.set(key, (groups.get(key) ?? new Set()).add(path))
  }
  const byCodePoint = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
  return [
    { title: 'SDK blank Session catalog', paths: catalogPaths },
    ...[...groups].sort(([a], [b]) => byCodePoint(a, b))
      .map(([key, paths]) => ({ title: key.replace(/^snapshots\/?/, '') || 'snapshots', paths: [...paths].sort(byCodePoint) })),
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
 * Renders the self-contained page.
 * @param files - Limited sections from {@link limitDiffs}.
 * @param groups - Groups from {@link groupDiffs}; the first one opens by default.
 * @param heading - Revision description shown under the title.
 * @returns HTML text.
 */
export function renderSnapshotDiffPage(files: readonly FileDiff[], groups: readonly DiffGroup[], heading: string): string {
  const data = JSON.stringify({ files, groups, heading }).replace(/</g, '\\u003c')
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
const { files, groups, heading } = JSON.parse(document.getElementById('data').textContent)
document.getElementById('heading').textContent = heading
const list = document.getElementById('list')
const view = document.getElementById('view')
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}
const buttons = groups.map((group, index) => {
  const button = el('button', { type: 'button', onclick: () => show(index) }, el('span', { textContent: group.title }), el('span', { textContent: String(group.paths.filter(path => files.some(file => file.path === path)).length) }))
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
    const sections = files.filter(candidate => candidate.path === path)
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
 * Appends a link to the page to a Preview fixture manifest.
 * @param manifestText - `fixtures.json` text the packer wrote.
 * @param href - Page URL relative to the manifest.
 * @returns The updated manifest text.
 */
export function addPreviewLink(manifestText: string, href: string): string {
  const manifest = JSON.parse(manifestText) as { links?: unknown[] }
  return `${JSON.stringify({ ...manifest, links: [...manifest.links ?? [], { label: 'Snapshot changes', href }] }, null, 2)}\n`
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 30 })
}

const DIFF = ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-renames', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '--unified=5']

/** Requires a regular file, because git diffs a symlink as its target path rather than the content it names. */
function assertRegularFile(rev: string, path: string): void {
  const mode = git('ls-tree', rev, '--', path).split(' ')[0]
  if (mode !== '100644' && mode !== '100755') throw new Error(`catalog file ${path} at ${rev} is not a regular file (mode ${mode || 'missing'})`)
}

/**
 * Diffs one catalog sidecar. When its source scenario moved, the blobs are
 * compared directly under an `old → new` label, because neither file changed.
 */
function catalogDiff(base: string, head: string, from: string, to: string): { path: string; extra?: FileDiff } {
  assertRegularFile(base, from)
  assertRegularFile(head, to)
  if (from === to) return { path: to }
  const path = `${from} → ${to}`
  const text = git(...DIFF, `${base}:${from}`, `${head}:${to}`)
  return text === '' ? { path } : { path, extra: section(path, text.split('\n')) }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { 'base': { type: 'string' }, 'head': { type: 'string' }, 'out': { type: 'string' }, 'preview-manifest': { type: 'string' } } })
  const { base, head, out } = values
  if (!base || !head || !out) throw new Error('usage: snapshot-diff-page.ts --base <rev> --head <rev> --out <file> [--preview-manifest <fixtures.json>]')
  const short = (rev: string) => git('rev-parse', '--short', rev).trim()
  const changed = parseUnifiedDiff(git(...DIFF, base, head, '--', 'snapshots/'))
  const manifestAt = (rev: string) => catalogFiles(git('show', `${rev}:snapshots/${CATALOG_SCENARIO}/snapshot.yml`))
  const from = manifestAt(base)
  const to = manifestAt(head)
  const catalog = [catalogDiff(base, head, from.systemPrompt, to.systemPrompt), catalogDiff(base, head, from.toolSchemas, to.toolSchemas)]
  const files = limitDiffs([...catalog.flatMap(entry => entry.extra ? [entry.extra] : []), ...changed])
  const page = renderSnapshotDiffPage(files, groupDiffs(changed, catalog.map(entry => entry.path)), `${short(base)} → ${short(head)}`)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, page)
  const manifest = values['preview-manifest']
  if (manifest) {
    const href = `${relative(dirname(manifest), dirname(out)).split(sep).join(posix.sep)}/`
    writeFileSync(manifest, addPreviewLink(readFileSync(manifest, 'utf8'), href))
  }
}
