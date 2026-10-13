/** Minimal Typert workspace for specs of the bundle-free Typert pass and its build steps. */

import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Workspace-relative root of the fixture's single Typert contributor. */
export const TYPERT_FIXTURE_PACKAGE = 'packages/fixture/probe'

/**
 * Write a workspace whose `tsconfig.host.json` references one compilable package that declares
 * `./typert` and publishes an explicit `@typert` schema root.
 * @param root - empty directory that becomes the workspace root.
 * @param source - the package's `src/index.ts`.
 * @returns absolute path of the contributor package.
 */
export function writeTypertWorkspace(root: string, source = '/** @typert schema */\nexport interface Payload { value: string }\n'): string {
  const files: Record<string, unknown> = {
    'tsconfig.base.json': {
      compilerOptions: {
        target: 'ES2024',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        lib: ['ES2024'],
        types: [],
        strict: true,
        composite: true,
        declaration: true,
        skipLibCheck: true,
      },
    },
    'tsconfig.host.json': {
      extends: './tsconfig.base.json',
      compilerOptions: { noEmit: true },
      files: [],
      references: [{ path: `./${TYPERT_FIXTURE_PACKAGE}` }],
    },
    [`${TYPERT_FIXTURE_PACKAGE}/tsconfig.json`]: {
      extends: '../../../tsconfig.base.json',
      compilerOptions: { rootDir: 'src', outDir: 'lib/types' },
      include: ['src'],
    },
    [`${TYPERT_FIXTURE_PACKAGE}/package.json`]: {
      name: '@fixture/probe',
      type: 'module',
      exports: {
        '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
        './typert': { types: './lib/typert.host.d.ts', default: './lib/typert.host.js' },
      },
      files: ['lib/typert.host.js', 'lib/typert.host.d.ts'],
    },
  }
  for (const [path, content] of Object.entries(files)) writeFixtureFile(join(root, path), `${JSON.stringify(content, null, 2)}\n`)
  writeFixtureFile(join(root, TYPERT_FIXTURE_PACKAGE, 'src/index.ts'), source)
  return join(root, TYPERT_FIXTURE_PACKAGE)
}

function writeFixtureFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/** Contributor source that imports {@link writeCompiledDependency}'s package through a subpath. */
export const DEPENDENT_TYPERT_SOURCE = "import type { Shape } from '@fixture/dep/types'\n\n/** @typert schema */\nexport interface Payload { shape: Shape }\n"

/**
 * Add a Host package, `@fixture/dep`, linked into `node_modules` and referenced from
 * `tsconfig.host.json`. Without a `paths` alias, `@fixture/dep/types` resolves through the link to
 * its compiled `lib/types/types.d.ts`, or to nothing before the package compiles.
 * @param root - workspace written by {@link writeTypertWorkspace}.
 * @param compiled - whether `lib/types/types.d.ts` exists, as after package compilation.
 * @returns absolute path of the dependency package.
 */
export function writeCompiledDependency(root: string, compiled = true): string {
  const dependency = join(root, 'packages/fixture/dep')
  const declaration = 'export interface Shape { side: number }\n'
  writeFixtureFile(join(dependency, 'package.json'), `${JSON.stringify({
    name: '@fixture/dep',
    type: 'module',
    exports: { './types': { types: './lib/types/types.d.ts', default: './lib/types/types.js' } },
  }, null, 2)}\n`)
  writeFixtureFile(join(dependency, 'tsconfig.json'), `${JSON.stringify({
    extends: '../../../tsconfig.base.json',
    compilerOptions: { rootDir: 'src', outDir: 'lib/types' },
    include: ['src'],
  }, null, 2)}\n`)
  const aggregatePath = join(root, 'tsconfig.host.json')
  const aggregate = JSON.parse(readFileSync(aggregatePath, 'utf8')) as { references: { path: string }[] }
  aggregate.references.push({ path: './packages/fixture/dep' })
  writeFixtureFile(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`)
  writeFixtureFile(join(dependency, 'src/types.ts'), declaration)
  if (compiled) writeFixtureFile(join(dependency, 'lib/types/types.d.ts'), declaration)
  mkdirSync(join(root, 'node_modules/@fixture'), { recursive: true })
  symlinkSync(dependency, join(root, 'node_modules/@fixture/dep'), 'junction')
  return dependency
}

/**
 * Replace the contributor manifest's publish list, for example to omit a generated file.
 * @param pkg - contributor package returned by {@link writeTypertWorkspace}.
 * @param files - the new `package.json#files`.
 */
export function setPublishedFiles(pkg: string, files: readonly string[]): void {
  const manifestPath = join(pkg, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  writeFixtureFile(manifestPath, `${JSON.stringify({ ...manifest, files }, null, 2)}\n`)
}
