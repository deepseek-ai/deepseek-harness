/**
 * Verify that built package declarations are consumable by a standard external
 * TypeScript ESM project using NodeNext resolution.
 *
 * Run after `pnpm run build` has emitted declaration files under package
 * `lib/types` directories.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

interface ExportTarget {
  types?: string
}

interface PackageManifest {
  name?: string
  types?: string
  exports?: Record<string, ExportTarget | string | null>
}

interface WorkspacePackage {
  dir: string
  name: string
  manifest: PackageManifest
}

function readPackage(path: string): WorkspacePackage | null {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
  if (!manifest.name) return null
  return { dir: dirname(path), name: manifest.name, manifest }
}

function workspacePackages(): WorkspacePackage[] {
  return [
    ...globSync('vendor/*/package.json', { cwd: root }),
    ...globSync('vendor/im/*/package.json', { cwd: root }),
    ...globSync('packages/*/*/package.json', { cwd: root }),
  ]
    .map(path => readPackage(resolve(root, path)))
    .filter(pkg => pkg !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
}

const declarationSpecifierPattern = /(?:from\s*|import\s*\(\s*|import\s+|declare\s+module\s*)["'](\.{0,2}(?:\/[^"']*)?)["']/g
const hasExtension = /\.[^/.]+$/

function relativeSpecifiersMissingExtensions(): string[] {
  const errors: string[] = []
  const files = [
    ...globSync('vendor/*/lib/types/**/*.d.ts', { cwd: root }),
    ...globSync('vendor/im/*/lib/types/**/*.d.ts', { cwd: root }),
    ...globSync('packages/*/*/lib/types/**/*.d.ts', { cwd: root }),
  ].sort()

  for (const file of files) {
    const text = readFileSync(resolve(root, file), 'utf8')
    for (const match of text.matchAll(declarationSpecifierPattern)) {
      const specifier = match[1]
      if (!specifier) continue
      const isRelative = specifier === '.' || specifier.startsWith('./') || specifier.startsWith('../')
      if (isRelative && !hasExtension.test(specifier)) errors.push(`${file}: ${specifier}`)
    }
  }

  return errors
}

function publicSpecifiers(pkg: WorkspacePackage): string[] {
  const specifiers = new Set<string>()
  if (pkg.manifest.types) specifiers.add(pkg.name)

  for (const [key, target] of Object.entries(pkg.manifest.exports ?? {})) {
    if (key.includes('*') || key === './package.json') continue
    if (typeof target !== 'object' || target === null || !target.types) continue
    specifiers.add(key === '.' ? pkg.name : `${pkg.name}/${key.slice(2)}`)
  }

  return [...specifiers].sort()
}

function linkPackage(pkg: WorkspacePackage, nodeModules: string): void {
  const parts = pkg.name.split('/')
  const link = resolve(nodeModules, ...parts)
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(pkg.dir, link, 'dir')
}

const packages = workspacePackages()
const badSpecifiers = relativeSpecifiersMissingExtensions()
if (badSpecifiers.length > 0) {
  console.error('verify-node-next-types: declaration files still contain relative specifiers without file extensions.')
  console.error(badSpecifiers.join('\n'))
  process.exit(1)
}

const missingOutputs = packages
  .filter(pkg => pkg.manifest.types && !existsSync(resolve(pkg.dir, pkg.manifest.types)))
  .map(pkg => `${pkg.name}: missing ${pkg.manifest.types}`)

if (missingOutputs.length > 0) {
  console.error('verify-node-next-types: build outputs are missing; run `pnpm run build` first.')
  console.error(missingOutputs.join('\n'))
  process.exit(1)
}

const tmp = mkdtempSync(resolve(root, '.node-next-types-'))
let failed = false

try {
  const nodeModules = resolve(tmp, 'node_modules')
  mkdirSync(nodeModules, { recursive: true })
  for (const pkg of packages) linkPackage(pkg, nodeModules)

  const rootTypes = resolve(root, 'node_modules/@types/node')
  if (existsSync(rootTypes)) {
    const typesDir = resolve(nodeModules, '@types')
    mkdirSync(typesDir, { recursive: true })
    symlinkSync(rootTypes, resolve(typesDir, 'node'), 'dir')
  }

  writeFileSync(resolve(tmp, 'package.json'), `${JSON.stringify({ type: 'module', private: true }, null, 2)}\n`)
  writeFileSync(resolve(tmp, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'es2024',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      // Third-party SDK declarations can have their own lib-check noise under a
      // symlinked temp install. The explicit scan above owns our regression:
      // relative specifiers without file extensions in built declarations.
      skipLibCheck: true,
      preserveSymlinks: true,
      noEmit: true,
      types: ['node'],
    },
    include: ['index.ts'],
  }, null, 2)}\n`)

  const imports = packages.flatMap(publicSpecifiers)
    .map((specifier, index) => `import * as mod${index} from ${JSON.stringify(specifier)};\nvoid mod${index};`)
    .join('\n')
  writeFileSync(resolve(tmp, 'index.ts'), `${imports}\n`)

  // tsc's JS entry via the current node, not the .bin shim: the extensionless
  // shim isn't spawnable on Windows (CVE-2024-27980) and the .cmd variant needs
  // shell:true, which space-joins args UNESCAPED (DEP0190) — a hazard for the
  // temp tsconfig path. The JS entry behaves identically on every platform.
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', resolve(tmp, 'tsconfig.json'), '--pretty', 'false'], {
    cwd: root,
    stdio: 'pipe',
  })
  console.log(`verify-node-next-types: ${packages.length} workspace package declaration API(s) compile under NodeNext.`)
} catch (error: unknown) {
  failed = true
  const output = error as { stdout?: Buffer; stderr?: Buffer }
  console.error('verify-node-next-types: NodeNext consumer typecheck failed.\n')
  console.error(`${output.stdout?.toString() ?? ''}${output.stderr?.toString() ?? ''}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

if (failed) process.exit(1)
