/** Read the source list: one npm package name or Git repository URL per line. */
import { parseMarketIndex, type MarketIndexError } from '@deepseek-ai/dsh-plugin-market-index'

/** One line of the source list. */
export type Source =
  | { readonly kind: 'npm'; readonly line: string; readonly name: string }
  | { readonly kind: 'git'; readonly line: string; readonly url: string }

/** Throw the reason the index format rejects a plugin with this name and source. */
function check(name: string, source: object): void {
  const version = { version: '0.0.0', publishTimestamp: 0, source }
  parseMarketIndex({ format: 1, title: 'check', plugins: [{ name, versions: [version] }] }, 'https://index.invalid/')
}

/**
 * Parse a source list. Blank lines and lines starting with `#` are ignored; a trailing `/` or `.git` on a repository
 * URL is dropped, so `https://github.com/o/r/` and `https://github.com/o/r.git` name the same repository. Every line
 * must be a package name or a Git URL the index format accepts.
 * @param text - the list file contents.
 * @returns the sources in file order, without repeats.
 * @throws when a line is neither an npm package name nor an https repository URL.
 */
export function parseSources(text: string): Source[] {
  const sources: Source[] = []
  const seen = new Set<string>()
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    let source: Source
    try {
      if (line.includes('://')) {
        const url = URL.canParse(line) ? new URL(line).href.replace(/\/+$/u, '').replace(/\.git$/u, '') : line
        check('placeholder', { type: 'git', url, commit: '0'.repeat(40) })
        source = { kind: 'git', line, url }
      } else {
        check(line, { type: 'npm' })
        source = { kind: 'npm', line, name: line }
      }
    } catch (error) {
      throw new Error(`line ${index + 1}: not an npm package name or an https Git repository URL (${(error as MarketIndexError).reason}): ${line}`)
    }
    const key = source.kind === 'npm' ? `npm:${source.name}` : `git:${source.url}`
    if (seen.has(key)) continue
    seen.add(key)
    sources.push(source)
  }
  return sources
}
