/** Generate the build-static Session format catalog from edge package metadata. */

import { globSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DshSessionFormatMigrationManifest } from '@deepseek-ai/dsh-package-manifest'

const root = resolve(import.meta.dirname, '..')
const OUT = 'packages/session/session-format-catalog/src/generated.ts'

/** Validated adjacent migration metadata with its resolved package import path. */
export interface SessionFormatMigrationManifest extends Readonly<Omit<DshSessionFormatMigrationManifest, 'export'>> {
  readonly packageName: string
  readonly importPath: string
}

interface RawManifest {
  readonly name?: unknown
  readonly dependencies?: Readonly<Record<string, unknown>>
  readonly peerDependencies?: Readonly<Record<string, unknown>>
  readonly devDependencies?: Readonly<Record<string, unknown>>
  readonly dsh?: {
    readonly sessionFormatMigration?: Readonly<Record<string, unknown>>
  }
}

function readJson(path: string): RawManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as RawManifest
}

function safeVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
    throw new Error(`gen-session-format-catalog: ${label} must be a non-negative safe integer`)
  }
  return value as number
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`gen-session-format-catalog: ${label} must be a non-empty string`)
  }
  return value
}

/**
 * Read the current writer version from the core Session source of truth.
 * @param scanRoot - repository root whose Session source is authoritative.
 * @returns the current non-negative Session format version.
 */
export function readCurrentSessionFormatVersion(scanRoot: string = root): number {
  const source = readFileSync(resolve(scanRoot, 'packages/core/session/src/types.ts'), 'utf8')
  const match = source.match(/export const SESSION_FORMAT_VERSION = (\d+)\b/)
  if (match === null) throw new Error('gen-session-format-catalog: cannot read SESSION_FORMAT_VERSION')
  return safeVersion(Number(match[1]), 'SESSION_FORMAT_VERSION')
}

/**
 * Collect and validate the unique complete adjacent migration inventory.
 * @param scanRoot - repository root containing migration package manifests.
 * @param currentVersion - writer version the inventory must reach exactly.
 * @returns ordered adjacent migration declarations from v0 to the current writer.
 */
export function collectSessionFormatMigrations(
  scanRoot: string = root,
  currentVersion: number = readCurrentSessionFormatVersion(scanRoot),
): SessionFormatMigrationManifest[] {
  const declarations: SessionFormatMigrationManifest[] = []
  for (const discovered of globSync('packages/session/session-format-v*-to-v*/package.json', { cwd: scanRoot }).sort()) {
    const rel = discovered.replaceAll('\\', '/')
    const manifest = readJson(resolve(scanRoot, rel))
    const metadata = manifest.dsh?.sessionFormatMigration
    if (metadata === undefined) {
      throw new Error(`gen-session-format-catalog: ${rel} lacks dsh.sessionFormatMigration`)
    }
    const allowed: ReadonlySet<string> = new Set<keyof DshSessionFormatMigrationManifest>([
      'from', 'to', 'export', 'migration', 'sourceCodec', 'targetCodec',
      'targetHeaderValidator', 'targetRestorer',
    ])
    const extra = Object.keys(metadata).find(key => !allowed.has(key))
    if (extra !== undefined) throw new Error(`gen-session-format-catalog: ${rel} has unknown metadata member ${extra}`)
    const packageName = nonempty(manifest.name, `${rel} name`)
    const from = safeVersion(metadata['from'], `${rel} from`)
    const to = safeVersion(metadata['to'], `${rel} to`)
    if (to !== from + 1) throw new Error(`gen-session-format-catalog: ${rel} must declare adjacent v${from}->v${from + 1}`)
    const expectedPackageName = `@deepseek-ai/dsh-session-format-v${from}-to-v${to}`
    if (packageName !== expectedPackageName) {
      throw new Error(`gen-session-format-catalog: ${rel} name must be ${expectedPackageName}`)
    }
    const directoryMatch = rel.match(/session-format-v(\d+)-to-v(\d+)\/package\.json$/)
    if (directoryMatch === null || Number(directoryMatch[1]) !== from || Number(directoryMatch[2]) !== to) {
      throw new Error(`gen-session-format-catalog: ${rel} directory does not match v${from}->v${to}`)
    }
    const exportPath = nonempty(metadata['export'], `${rel} export`)
    declarations.push({
      packageName,
      importPath: exportPath === '.' ? packageName : `${packageName}/${exportPath.replace(/^\.\//, '')}`,
      from,
      to,
      migration: nonempty(metadata['migration'], `${rel} migration`),
      sourceCodec: nonempty(metadata['sourceCodec'], `${rel} sourceCodec`),
      targetCodec: nonempty(metadata['targetCodec'], `${rel} targetCodec`),
      targetHeaderValidator: nonempty(metadata['targetHeaderValidator'], `${rel} targetHeaderValidator`),
      targetRestorer: nonempty(metadata['targetRestorer'], `${rel} targetRestorer`),
    })
  }
  declarations.sort((left, right) => left.from - right.from)
  for (let version = 0; version < currentVersion; version += 1) {
    const matches = declarations.filter(item => item.from === version)
    if (matches.length !== 1) {
      throw new Error(`gen-session-format-catalog: expected exactly one v${version}->v${version + 1} package, found ${matches.length}`)
    }
  }
  const extra = declarations.find(item => item.from >= currentVersion)
  if (extra !== undefined || declarations.length !== currentVersion) {
    throw new Error(`gen-session-format-catalog: migration inventory does not end exactly at current v${currentVersion}`)
  }
  const catalog = readJson(resolve(scanRoot, 'packages/session/session-format-catalog/package.json'))
  if (catalog.dependencies?.['@deepseek-ai/dsh-session'] !== undefined
    || catalog.peerDependencies?.['@deepseek-ai/dsh-session'] === undefined
    || catalog.devDependencies?.['@deepseek-ai/dsh-session'] === undefined) {
    throw new Error(
      'gen-session-format-catalog: catalog must share @deepseek-ai/dsh-session through peer + dev dependencies',
    )
  }
  for (const [index, declaration] of declarations.entries()) {
    if (catalog.dependencies?.[declaration.packageName] === undefined) {
      throw new Error(`gen-session-format-catalog: catalog package lacks dependency ${declaration.packageName}`)
    }
    const previous = declarations[index - 1]
    if (previous === undefined) continue
    if (declaration.sourceCodec !== previous.targetCodec) {
      throw new Error(
        `gen-session-format-catalog: v${declaration.from} source codec ${declaration.sourceCodec} `
        + `does not continue ${previous.targetCodec}`,
      )
    }
    const manifest = readJson(resolve(
      scanRoot,
      `packages/session/session-format-v${declaration.from}-to-v${declaration.to}/package.json`,
    ))
    if (manifest.dependencies?.[previous.packageName] === undefined) {
      throw new Error(
        `gen-session-format-catalog: ${declaration.packageName} must depend on ${previous.packageName} `
        + 'to share the adjacent source codec',
      )
    }
  }
  return declarations
}

/**
 * Render the deterministic direct-import catalog source.
 * @param declarations - validated adjacent migrations in version order.
 * @param currentVersion - writer version reached by the final declaration.
 * @returns complete generated TypeScript source.
 */
export function renderSessionFormatCatalog(
  declarations: readonly SessionFormatMigrationManifest[],
  currentVersion: number,
): string {
  const imports = declarations.map((item) => {
    const names = [item.targetCodec, item.migration]
    if (item.from === 0) names.push(item.sourceCodec)
    if (item.to === currentVersion) names.push(item.targetRestorer, item.targetHeaderValidator)
    return `import { ${[...new Set(names)].sort().join(', ')} } from '${item.importPath}'`
  })
  const first = declarations[0]
  const codecs = first === undefined
    ? []
    : [first.sourceCodec, ...declarations.map(item => item.targetCodec)]
  const restorer = declarations.at(-1)?.targetRestorer
  const headerValidator = declarations.at(-1)?.targetHeaderValidator
  const currentCodec = declarations.at(-1)?.targetCodec
  if (restorer === undefined) throw new Error('gen-session-format-catalog: current format has no target restorer')
  if (headerValidator === undefined) {
    throw new Error('gen-session-format-catalog: current format has no target header validator')
  }
  if (currentCodec === undefined) throw new Error('gen-session-format-catalog: current format has no target codec')
  return [
    '/**',
    ' * GENERATED by `scripts/gen-session-format-catalog.ts` — do not edit by hand.',
    ' * The direct imports make historical readability independent of mounted plugins.',
    ' */',
    '',
    "import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'",
    "import { createSessionFormatCatalog } from '@deepseek-ai/dsh-session-format'",
    "import { validateInstalledCurrentSessionArtifact, validateInstalledCurrentSessionHeader } from './current.ts'",
    ...imports,
    '',
    '/** Physical codec dispatch and complete adjacent chain, independent of mounted plugins. */',
    'export const sessionFormatCatalog = createSessionFormatCatalog({',
    `  currentVersion: ${currentVersion},`,
    `  codecs: [${codecs.join(', ')}],`,
    `  currentEncoder: ${currentCodec},`,
    `  migrations: [${declarations.map(item => item.migration).join(', ')}],`,
    '  restoreCurrent(artifact) {',
    `    const restored = ${restorer}(artifact, KNOWN_SESSION_EVENT_TYPES)`,
    '    validateInstalledCurrentSessionArtifact(restored)',
    '    return restored',
    '  },',
    '  restoreTransformedCurrent(artifact) {',
    `    return ${restorer}(artifact, KNOWN_SESSION_EVENT_TYPES)`,
    '  },',
    '  restoreCurrentHeader(header) {',
    `    ${headerValidator}(header)`,
    '    validateInstalledCurrentSessionHeader(header)',
    '    return header',
    '  },',
    '})',
    '',
  ].join('\n')
}

function main(): void {
  const currentVersion = readCurrentSessionFormatVersion(root)
  const declarations = collectSessionFormatMigrations(root, currentVersion)
  const output = renderSessionFormatCatalog(declarations, currentVersion)
  const target = resolve(root, OUT)
  if (process.argv.includes('--check')) {
    let current = ''
    try { current = readFileSync(target, 'utf8') } catch { /* missing is stale */ }
    if (current !== output) {
      console.error(`gen-session-format-catalog: ${OUT} is stale; run pnpm run gen-session-format-catalog`)
      process.exitCode = 1
      return
    }
    console.log(`gen-session-format-catalog: ${OUT} is up to date.`)
    return
  }
  writeFileSync(target, output)
  console.log(`gen-session-format-catalog: wrote ${OUT}.`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
