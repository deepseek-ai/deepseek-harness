/** Enforce the English package README Summary entry-length limit. */

import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

/** Maximum `wc -w`-style length of an English package README Summary. */
export const MAX_PACKAGE_README_SUMMARY_WORDS = 100

const PACKAGE_README_PATTERNS = [
  'packages/README.md',
  'packages/*/README.md',
  'packages/*/*/README.md',
] as const

/** `wc -w` equivalent used by the documentation budget gate. */
function countWords(text: string): number {
  return text.split(/\s+/u).filter(Boolean).length
}

/** Extract one H2 section body without consuming the next H2. */
function h2Body(source: string, heading: string): string | undefined {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = new RegExp(`^## ${escaped}\\s*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'mu').exec(source)
  return match?.[1]?.trim()
}

/** Read the package README kind for a diagnostic template link. */
function readKind(source: string): string | undefined {
  return /^kind:\s*["']?([a-z-]+)["']?\s*$/mu.exec(source)?.[1]
}

/**
 * Report Summary length violations for one English package README.
 * @param file - Repository-relative README path.
 * @param source - Complete README source.
 * @returns Diagnostics for a missing or oversized Summary.
 */
export function packageReadmeSummaryErrors(file: string, source: string): string[] {
  const summary = h2Body(source, 'Summary')
  if (summary === undefined) return [`${file}: missing \`## Summary\``]

  const words = countWords(summary)
  if (words <= MAX_PACKAGE_README_SUMMARY_WORDS) return []

  const kind = readKind(source)
  const template = kind === undefined
    ? '.agents/skills/dsh-doc/templates/'
    : `.agents/skills/dsh-doc/templates/${kind}.md`
  return [
    `${file}: Summary has ${String(words)} words; the limit is ${String(MAX_PACKAGE_README_SUMMARY_WORDS)}. Read .agents/skills/dsh-doc/SKILL.md and ${template} before rewriting it.`,
  ]
}

/** Find every authored English package README covered by the kind templates. */
function packageReadmes(): string[] {
  return PACKAGE_README_PATTERNS
    .flatMap(pattern => globSync(pattern, { cwd: root, exclude: ['**/node_modules/**'] }))
    .map(file => file.replaceAll('\\', '/'))
    .sort()
}

if (import.meta.main) {
  const files = packageReadmes()
  const failures = files.length === 0
    ? ['no English package READMEs found; the scan is empty or narrowed']
    : files.flatMap(file => packageReadmeSummaryErrors(file, readFileSync(resolve(root, file), 'utf8')))

  if (failures.length > 0) {
    console.error('verify-package-readme-summaries: violations found:')
    for (const failure of failures) console.error(`  ${failure}`)
    process.exitCode = 1
  } else {
    console.log(`verify-package-readme-summaries: ${String(files.length)} English package README Summaries are within ${String(MAX_PACKAGE_README_SUMMARY_WORDS)} words.`)
  }
}
