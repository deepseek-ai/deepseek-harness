/**
 * Full-corpus import gate: every built bundle in the workspace —
 * `packages/<group>/<package>/lib/index.js` and `vendor/<package>/lib/index.js`
 * — must be importable by Node's ESM loader. A bundle that stops importing (a
 * stray `.css` import, an emitted module Node cannot parse, a dependency that
 * throws at module scope) is reported by name.
 *
 * Baseline exemptions are a pinned list, not a count: an unlisted import
 * failure is a real finding (a bundle that stopped being importable), and it
 * must not hide inside a total. A listed file that becomes importable also
 * fails, so the list cannot rot.
 *
 * Cost: this walks the whole build output and imports every bundle serially in
 * one process, so it takes minutes on loaded runners and needs
 * `pnpm run build:lib:host` to have run. It is a heavyweight suite, not part
 * of a default aggregator run.
 *
 * Run: tsx tests/compile/transform-corpus-check.ts [files...]
 * With no arguments it discovers the corpus itself.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
const DOCKKIT_BUNDLE = 'packages/client/ui-dockkit/lib/index.js'

/**
 * Files Node's ESM loader cannot import in this repository. None is a finding:
 * each is listed with the reason the import fails, and the run refuses a
 * listed file that imports cleanly so the list stays current in both
 * directions. The koffi entry depends on corpus order: sandbox-windows-acl
 * imports the win32-process package earlier in the serial sweep (a distinct
 * module instance under its node_modules URL), so win32-process's own file-URL
 * import re-registers koffi's type names and fails as the second load.
 *
 * The Dockkit entry admits only Node's refusal of a `.css` import, not one
 * exact stylesheet: the swept bundle's first unresolvable stylesheet depends on
 * its import graph and on how the launcher resolves workspace packages, so a
 * pinned path would certify an import order instead of the `.css` exemption.
 */
const BASELINE_EXEMPT: ReadonlyMap<string, string> = new Map([
  [DOCKKIT_BUNDLE, 'imports .css, which bare Node cannot load'],
  ['packages/client/ui-primitives/lib/index.js', 'imports .css, which bare Node cannot load'],
  ['packages/client/web/lib/index.js', 'imports .css, which bare Node cannot load'],
  ['packages/subprocess/win32-process/lib/index.js', 'koffi type-name collision on a second load'],
  ['packages/test-support/client-runtime/lib/index.js', "needs vitest's internal state"],
])

let failures = 0
const report: string[] = []
const log = (line: string): void => {
  report.push(line)
  process.stdout.write(`${line}\n`)
}
const fail = (line: string): void => {
  failures += 1
  log(line)
}

/** @returns Built bundles under a two-level package directory, in stable order. */
function discover(): string[] {
  const found: string[] = []
  /** @returns Sorted subdirectory names, or none when the path is not a readable directory. */
  const subdirectories = (path: string): string[] => {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort()
    } catch {
      return []
    }
  }
  for (const group of ['packages', 'vendor']) {
    const groupDirectory = join(repositoryRoot, group)
    for (const entry of subdirectories(groupDirectory)) {
      // `packages/<group>/<package>/lib/index.js`, `vendor/<package>/lib/index.js`.
      const candidates = group === 'vendor'
        ? [join(groupDirectory, entry, 'lib', 'index.js')]
        : subdirectories(join(groupDirectory, entry))
          .map(child => join(groupDirectory, entry, child, 'lib', 'index.js'))
      for (const candidate of candidates) {
        try {
          if (statSync(candidate).isFile()) found.push(candidate)
        } catch {
          // No bundle for this package: it may not build a runtime artifact.
        }
      }
    }
  }
  return found
}

/**
 * @returns Path relative to the repository root, for stable diagnostics.
 * Always POSIX-separated: the exemption table keys on one form, and a win32
 * walk would otherwise miss every entry.
 */
const relative = (path: string): string => path.slice(repositoryRoot.length).replaceAll('\\', '/')

/**
 * @param reason - the value the corpus import rejected with.
 * @returns whether bare Node refused a `.css` import, the failure the Dockkit
 * exemption admits.
 */
const isUnknownCssExtension = (reason: unknown): boolean =>
  reason instanceof Error
  && 'code' in reason && reason.code === 'ERR_UNKNOWN_FILE_EXTENSION'
  && reason.message.startsWith('Unknown file extension ".css" for ')

const files = process.argv.slice(2).length > 0
  ? process.argv.slice(2).map(path => (path.startsWith('/') ? path : join(process.cwd(), path)))
  : discover()

if (files.length === 0) {
  process.stdout.write('transform-corpus-check: no built bundles found; run `pnpm run build:lib:host` first\n')
  process.exitCode = 1
} else {
  const verdicts = { ok: 0, exempt: 0, unexpectedBaseline: 0 }

  for (const file of files) {
    const key = relative(file)
    const exemption = BASELINE_EXEMPT.get(key)
    try {
      await import(pathToFileURL(file).href)
    } catch (reason) {
      if (exemption === undefined || (key === DOCKKIT_BUNDLE && !isUnknownCssExtension(reason))) {
        // A bundle that stopped being importable is a real finding, so it
        // fails rather than joining a tolerated total.
        fail(`- UNEXPECTED BASELINE FAILURE ${key}: ${(reason as Error).message.split('\n')[0]}`)
        verdicts.unexpectedBaseline += 1
      } else {
        verdicts.exempt += 1
      }
      continue
    }
    if (exemption !== undefined) {
      // The exemption list must stay honest in the other direction too: a file
      // that became importable should leave the list.
      fail(`- STALE EXEMPTION ${key}: imports fine now (${exemption}); remove it from BASELINE_EXEMPT`)
      continue
    }
    verdicts.ok += 1
  }

  log('')
  log(`files=${String(files.length)} ok=${String(verdicts.ok)} baselineExempt=${String(verdicts.exempt)} `
    + `unexpectedBaselineFailure=${String(verdicts.unexpectedBaseline)}`)

  process.stdout.write(failures === 0
    ? `\ntransform-corpus-check: ${String(verdicts.ok)} bundles import under Node, `
      + `${String(verdicts.exempt)} exempt\n`
    : `\ntransform-corpus-check: ${String(failures)} finding(s)\n`)
  process.exitCode = failures === 0 ? 0 : 1
}
