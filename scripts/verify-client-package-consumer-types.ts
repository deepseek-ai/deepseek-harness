/**
 * Verify the type compatibility commitment to external TypeScript consumers of the three `immediately` Client packages,
 * whose root types are their `./client` declarations. Code outside the repository may import
 * `@deepseek-ai/dsh-client-ui-slots` by package root or by its `/client` subpath, augment either spelling, and mix them
 * in one file or across files; every importer reads one merged interface. The fixtures in
 * `scripts/fixtures/client-package-consumer/` compile against the built `lib/types` declarations through
 * `node_modules` and the package `exports`, never through the repository's tsconfig paths, once under NodeNext and
 * once under Bundler module resolution.
 *
 * A negative control compiles the two mixed-spelling scenarios against a copy of the package whose root `types` is a
 * separate declaration file that re-exports `./client` through `export *`. TypeScript merges the two spellings there
 * only when it processes the `/client` augmentation first, so the scenarios must fail, which shows that the fixtures
 * depend on the root and `./client` sharing one declaration file.
 *
 * Run after `pnpm run build`.
 */

import { cpSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'

const GATE = 'verify-client-package-consumer-types'
const root = resolve(import.meta.dirname, '..')
const FIXTURES = resolve(import.meta.dirname, 'fixtures/client-package-consumer')
const SLOTS = '@deepseek-ai/dsh-client-ui-slots'

/** One consumer program: its files in the order the compiler processes them. */
interface Scenario {
  readonly name: string
  readonly files: readonly string[]
}

const TWO_FILES = ['root-augmentation.ts', 'client-augmentation.ts'] as const

const SCENARIOS: readonly Scenario[] = [
  { name: 'package-root spelling', files: ['root-spelling.ts'] },
  { name: '/client spelling', files: ['client-spelling.ts'] },
  { name: 'both spellings in one file', files: ['mixed-spellings.ts'] },
  { name: 'both spellings in two files, package root first', files: [...TWO_FILES, 'two-file-assertions.ts'] },
  { name: 'both spellings in two files, /client first', files: [...[...TWO_FILES].reverse(), 'two-file-assertions.ts'] },
]

/** The scenarios a package root that forwards to `./client` through a separate file must break. */
const NEGATIVE_CONTROL = new Set(['both spellings in one file', 'both spellings in two files, package root first'])

const RESOLUTIONS: readonly { readonly name: string; readonly options: ts.CompilerOptions }[] = [
  { name: 'NodeNext', options: { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext } },
  { name: 'Bundler', options: { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler } },
]

const COMMON_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2024,
  lib: ['lib.es2024.d.ts', 'lib.dom.d.ts'],
  strict: true,
  noEmit: true,
  allowImportingTsExtensions: true,
  // Declarations of third-party packages are outside this check; the fixtures' own diagnostics are not skipped.
  skipLibCheck: true,
  // The consumer installs the packages as links; resolving through the link keeps the consumer's node_modules view.
  preserveSymlinks: true,
  types: [],
}

interface WorkspacePackage {
  readonly dir: string
  readonly name: string
}

function workspacePackages(): WorkspacePackage[] {
  return ['vendor/*/package.json', 'vendor/im/*/package.json', 'packages/*/*/package.json']
    .flatMap(pattern => globSync(pattern, { cwd: root }))
    .flatMap((path) => {
      const manifest = JSON.parse(readFileSync(resolve(root, path), 'utf8')) as { name?: unknown }
      return typeof manifest.name === 'string' ? [{ dir: dirname(resolve(root, path)), name: manifest.name }] : []
    })
}

function link(target: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(target, path, 'dir')
}

/**
 * Lay out one consumer project: the fixtures, a `type: module` manifest, and `node_modules` with every workspace
 * package and the React and Node type packages linked in.
 * @param dir - Empty project directory.
 * @param replace - Package directories that replace the workspace package of the same name.
 * @returns The project directory.
 */
function consumerProject(dir: string, replace: ReadonlyMap<string, string> = new Map()): string {
  cpSync(FIXTURES, dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ type: 'module', private: true }, null, 2)}\n`)
  for (const pkg of workspacePackages()) link(replace.get(pkg.name) ?? pkg.dir, join(dir, 'node_modules', ...pkg.name.split('/')))
  for (const types of ['react', 'react-dom', 'node']) {
    link(resolve(root, 'node_modules/@types', types), join(dir, 'node_modules/@types', types))
  }
  return dir
}

/**
 * Build a copy of `@deepseek-ai/dsh-client-ui-slots` whose root `types` is a separate file that re-exports the
 * `./client` declarations through `export *`; `lib` and `node_modules` link to the built package.
 * @param dir - Empty directory for the copy.
 * @returns The package directory.
 */
function forwardingRootPackage(dir: string): string {
  const source = workspacePackages().find(pkg => pkg.name === SLOTS)
  if (source === undefined) throw new Error(`${GATE}: no workspace package ${SLOTS}`)
  const manifest = JSON.parse(readFileSync(join(source.dir, 'package.json'), 'utf8')) as {
    types?: string
    exports: Record<string, { types?: string }>
  }
  const rootExport = manifest.exports['.']
  if (rootExport === undefined) throw new Error(`${GATE}: ${SLOTS} has no root export`)
  manifest.types = 'root.d.ts'
  rootExport.types = './root.d.ts'
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(dir, 'root.d.ts'), "export * from './lib/types/client/index.js'\n")
  link(join(source.dir, 'lib'), join(dir, 'lib'))
  link(join(source.dir, 'node_modules'), join(dir, 'node_modules'))
  return dir
}

/**
 * Compile one scenario program.
 * @param project - Consumer project directory.
 * @param scenario - Files in processing order.
 * @param options - Module and resolution options.
 * @returns Formatted diagnostics; empty when the program compiles.
 */
function compile(project: string, scenario: Scenario, options: ts.CompilerOptions): string[] {
  const program = ts.createProgram(scenario.files.map(file => join(project, file)), { ...COMMON_OPTIONS, ...options })
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    if (diagnostic.file === undefined || diagnostic.start === undefined) return message
    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
    return `${diagnostic.file.fileName.slice(project.length + 1)}(${line + 1},${character + 1}): ${message}`
  })
}

const tmp = mkdtempSync(join(tmpdir(), 'dsh-client-package-consumer-'))
const failures: string[] = []
try {
  const published = consumerProject(join(tmp, 'published'))
  const forwarding = consumerProject(join(tmp, 'forwarding'), new Map([[SLOTS, forwardingRootPackage(join(tmp, 'forwarding-root'))]]))
  for (const resolution of RESOLUTIONS) {
    for (const scenario of SCENARIOS) {
      const diagnostics = compile(published, scenario, resolution.options)
      if (diagnostics.length > 0) failures.push(`${scenario.name} (${resolution.name}):\n  ${diagnostics.join('\n  ')}`)
      if (!NEGATIVE_CONTROL.has(scenario.name)) continue
      if (compile(forwarding, scenario, resolution.options).length === 0) {
        failures.push(
          `negative control: ${scenario.name} (${resolution.name}) compiles against a package root that re-exports`
          + ' ./client from a separate file, so the fixtures no longer tell that layout apart from the published one',
        )
      }
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`${GATE}: the type compatibility commitment to external TypeScript consumers is broken:\n${failures.join('\n')}`)
  process.exit(1)
}
console.log(
  `${GATE}: type compatibility commitment to external TypeScript consumers holds: ${SCENARIOS.length} ${SLOTS}`
  + ` consumer programs compile under ${RESOLUTIONS.map(resolution => resolution.name).join(' and ')}, and`
  + ` ${NEGATIVE_CONTROL.size} mixed-spelling programs fail against a forwarding package root.`,
)
