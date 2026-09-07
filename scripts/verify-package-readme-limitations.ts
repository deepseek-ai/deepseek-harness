/**
 * Doc-sync gate for the canonical package-README limitations section. It scans
 * package manifests, rejects missing or variant sections, and requires one
 * top-level bullet; audited packages in {@link NO_LIMITATIONS} must omit it.
 * The archived [limitations gate record](../.agents/notes/archived/process/2026-07-10-readme-known-limitations-gate.md)
 * documents the original decision.
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { markdownHeadingLines, markdownProseLines } from './markdown.ts'

const root = resolve(import.meta.dirname, '..')

/** The one canonical section heading, required verbatim as an h2. */
const CANONICAL = '## Known Limitations and Deferred Work'

/** Packages audited as having no limitations section, keyed by repo-relative directory. */
const NO_LIMITATIONS: Readonly<Record<string, string>> = {
  'packages/util/brand': 'Stateless nominal-string and canonical-key helpers have no deferred work.',
}

/** A heading that reads as a limitations section — canonical or drifted. */
function isLimitationsLike(headingText: string): boolean {
  return (
    /\blimitations?\b/i.test(headingText)
    || /deferred work/i.test(headingText)
    || /what is not here/i.test(headingText)
    || /^deferred\b/i.test(headingText)
    || /^non-goals?\b/i.test(headingText)
  )
}

const packageJsons = globSync('packages/*/*/package.json', { cwd: root }).map(path => path.split(sep).join('/')).sort()
const scannedPackages = new Set(packageJsons.map(path => path.slice(0, -'/package.json'.length)))
const failures: string[] = []

for (const [entry, reason] of Object.entries(NO_LIMITATIONS)) {
  if (!scannedPackages.has(entry)) {
    failures.push(`whitelist entry ${entry} does not name a scanned package — renamed or removed? update NO_LIMITATIONS in scripts/verify-package-readme-limitations.ts in the same change`)
  }
  if (reason.trim().length === 0) {
    failures.push(`whitelist entry ${entry} has no justification — state why a limitations section would be empty boilerplate`)
  }
}

for (const pkg of scannedPackages) {
  const readme = `${pkg}/README.md`
  if (!existsSync(resolve(root, readme))) {
    failures.push(`${readme}: package manifest has no sibling README with the \`${CANONICAL}\` section`)
    continue
  }
  const source = readFileSync(resolve(root, readme), 'utf8')
  const lines = markdownProseLines(source)
  const headings = markdownHeadingLines(source)
  const limitations = headings.filter(heading => isLimitationsLike(heading.text))

  if (Object.hasOwn(NO_LIMITATIONS, pkg)) {
    for (const heading of limitations) {
      failures.push(`${readme}:${heading.index}: whitelisted as having no known limitations, but carries ${JSON.stringify(heading.raw)} — drop the section or remove the package from NO_LIMITATIONS`)
    }
    continue
  }

  const heading = limitations.at(0)
  if (heading === undefined) {
    failures.push(`${readme}: missing the \`${CANONICAL}\` section (a package with genuinely nothing to declare joins NO_LIMITATIONS in scripts/verify-package-readme-limitations.ts instead)`)
    continue
  }
  if (limitations.length > 1) {
    failures.push(`${readme}: ${limitations.length} limitations-like headings (lines ${limitations.map(line => line.index).join(', ')}) — keep exactly one \`${CANONICAL}\` section`)
    continue
  }
  if (heading.depth !== 2 || heading.raw.trimEnd() !== CANONICAL) {
    failures.push(`${readme}:${heading.index}: non-canonical heading ${JSON.stringify(heading.raw)} — use \`${CANONICAL}\``)
    continue
  }
  const headingAt = lines.findIndex(line => line.index === heading.index)
  const body = lines.slice(headingAt + 1)
  const headingLines = new Set(headings.map(entry => entry.index))
  const end = body.findIndex(line => headingLines.has(line.index))
  const section = end === -1 ? body : body.slice(0, end)
  if (!section.some(line => /^- /.test(line.raw))) {
    failures.push(`${readme}:${heading.index}: the \`${CANONICAL}\` section has no top-level \`- \` bullet — state the limitations, or whitelist the package if there are genuinely none`)
  }
}

if (failures.length > 0) {
  console.error('verify-package-readme-limitations: violations found:')
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

console.log(`verify-package-readme-limitations: ${scannedPackages.size} package READMEs checked (${Object.keys(NO_LIMITATIONS).length} whitelisted), all conform.`)
