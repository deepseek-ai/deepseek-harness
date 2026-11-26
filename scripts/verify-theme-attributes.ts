/**
 * Reject feature-plugin reads and writes of the theme presenter's document attributes.
 *
 * ui-layout's theme presenter marks the active palette with `body[data-ds-dark-theme]` and the preference source with
 * `html[data-ds-theme-source]`. Feature plugins express a light/dark color difference with CSS `light-dark()` over
 * theme variables and any other difference through the `useTheme` standard prop or `ctx.theme`
 * ([rule](../docs/web-styling.md#component-rules)), so their stylesheets and scripts never name either attribute.
 *
 * The scan covers the `src/` stylesheets and TypeScript of every `packages/client/ui-*` package and of every
 * `packages/experimental/*` package whose manifest declares `dsh.client`. It matches the attribute names and their
 * `dataset` spellings anywhere in the text, comments included. {@link EXEMPT_PATHS} lists the owners: ui-theme, whose
 * palettes key on the attributes, and ui-layout's presenter, which writes them. The Web boot page in
 * `packages/client/web` and the Desktop shell and preload under `apps/desktop` are outside the scan: they style or watch
 * the document outside the plugin runtime.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const GATE = 'verify-theme-attributes'
const root = resolve(import.meta.dirname, '..')

/** Attribute names and `dataset` property spellings a feature plugin must not use. */
const THEME_ATTRIBUTE = /data-ds-dark-theme|data-ds-theme-source|\bdsDarkTheme\b|\bdsThemeSource\b/gu

/** Repository-relative paths, or directory prefixes ending in `/`, of the theme owners. */
export const EXEMPT_PATHS: readonly string[] = [
  'packages/client/ui-theme/',
  'packages/client/ui-layout/src/client/theme-presenter.ts',
]

/** One use of a theme attribute. */
export interface ThemeAttributeUse {
  /** Repository-relative path with forward slashes. */
  file: string
  /** One-based line. */
  line: number
  /** The matched attribute name or `dataset` property. */
  name: string
}

/**
 * Find theme attribute names in one source file.
 * @param file - repository-relative path, reported with each use.
 * @param source - stylesheet or TypeScript text.
 * @returns every match in source order.
 */
export function findThemeAttributeUses(file: string, source: string): ThemeAttributeUse[] {
  return [...source.matchAll(THEME_ATTRIBUTE)].map(match => ({
    file, line: source.slice(0, match.index).split('\n').length, name: match[0],
  }))
}

/**
 * Whether a path belongs to a feature plugin's scanned sources.
 * @param file - repository-relative path with forward slashes.
 * @param clientExperimental - names of `packages/experimental/*` directories whose manifest declares `dsh.client`.
 * @returns `true` for a `src/` stylesheet or TypeScript file outside {@link EXEMPT_PATHS}.
 */
export function isScannedSource(file: string, clientExperimental: ReadonlySet<string>): boolean {
  if (!/\.(?:css|tsx?)$/u.test(file) || EXEMPT_PATHS.some(path => path.endsWith('/') ? file.startsWith(path) : file === path)) return false
  const [group, scope, name, source] = file.split('/')
  if (group !== 'packages' || source !== 'src' || name === undefined) return false
  return (scope === 'client' && name.startsWith('ui-')) || (scope === 'experimental' && clientExperimental.has(name))
}

/**
 * List `packages/experimental/*` packages with a Client half.
 * @param repoRoot - repository root.
 * @param files - repository-relative tracked and unignored paths.
 * @returns directory names whose `package.json` declares `dsh.client`.
 */
function experimentalClientPackages(repoRoot: string, files: readonly string[]): Set<string> {
  const names = new Set<string>()
  for (const file of files) {
    const name = /^packages\/experimental\/([^/]+)\/package\.json$/u.exec(file)?.[1]
    if (name === undefined || !existsSync(resolve(repoRoot, file))) continue
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, file), 'utf8')) as { dsh?: { client?: unknown } }
    if (manifest.dsh?.client !== undefined) names.add(name)
  }
  return names
}

/**
 * Scan the repository's feature-plugin sources.
 * @param repoRoot - repository root containing the Git index.
 * @returns every use, by file and line.
 */
export function scanThemeAttributes(repoRoot: string): ThemeAttributeUse[] {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'packages'], {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }).split('\0').filter(Boolean)
  const clientExperimental = experimentalClientPackages(repoRoot, files)
  return files
    .filter(file => isScannedSource(file, clientExperimental) && existsSync(resolve(repoRoot, file)))
    .flatMap(file => findThemeAttributeUses(file, readFileSync(resolve(repoRoot, file), 'utf8')))
}

/**
 * Report every use and set a failing exit code when one exists.
 * @param repoRoot - repository root.
 */
export function main(repoRoot: string = root): void {
  const uses = scanThemeAttributes(repoRoot)
  if (uses.length === 0) {
    console.log(`${GATE}: OK`)
    return
  }
  for (const use of uses) console.error(`${use.file}:${String(use.line)}: ${use.name}`)
  console.error(`${GATE}: ${String(uses.length)} use(s) of the theme presenter's document attributes in feature plugins. `
    + 'Use CSS light-dark() over theme variables for colors, and the useTheme standard prop or ctx.theme for other light/dark differences.')
  process.exitCode = 1
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) main()
