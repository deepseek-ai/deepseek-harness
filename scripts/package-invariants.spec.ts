import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectPackageInvariantViolations,
  packageInvariantOwners,
} from './package-invariants.ts'
import { usesFlattenedPackageDependencies } from './package-dependency-policy.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function handwrittenInvariant(packageName: string): string {
  return `
export const name = 'probe-invariant'
export const inject = ['invariants']
const install = (ctx: { on(name: string, listener: (value: number) => void): void }, fail: (message: string) => never) => {
  ctx.on('probe/value', (value) => {
    if (value < 0) fail('observed values must be non-negative')
  })
}
export const apply = (ctx: { invariants: { register(name: string, install: typeof install): () => void } }) =>
  Promise.resolve(ctx.invariants.register(${JSON.stringify(packageName)}, install))
`
}

function fixture(options: {
  companion?: boolean
  packageName?: string
  packageDirectory?: string
  source?: string
  clientDeclaration?: boolean
  clientExport?: boolean
  invariantExport?: boolean
  invariantFile?: boolean
  invariantDependency?: boolean
  invariantReference?: boolean
  buildEntry?: boolean
  omissionReason?: boolean
} = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-package-invariants-'))
  roots.push(root)
  const packageDirectory = options.packageDirectory ?? 'packages/core/probe'
  const dir = join(root, packageDirectory)
  mkdirSync(join(dir, 'src'), { recursive: true })
  const packageName = options.packageName ?? '@deepseek-ai/dsh-probe'
  const companion = options.companion ?? true
  const invariantExport = options.invariantExport ?? companion
  const invariantFile = options.invariantFile ?? companion
  const invariantDependency = options.invariantDependency ?? companion
  const invariantReference = options.invariantReference ?? companion
  const buildEntry = options.buildEntry ?? companion
  const exports = {
    ...(invariantExport ? { './invariant': {
      types: './lib/types/invariant.d.ts',
      default: './lib/invariant.js',
    } } : {}),
    ...(options.clientExport === true ? {
      './client': {
        types: './lib/types/client/index.d.ts',
        default: './lib/client.js',
      },
    } : {}),
  }
  const dsh = options.clientDeclaration === true ? { client: {} } : undefined
  const developmentOnlyInvariant = usesFlattenedPackageDependencies(
    `${packageDirectory}/package.json`,
    packageName,
    dsh,
  )
  const manifest = {
    name: packageName,
    ...(dsh === undefined ? {} : { dsh }),
    exports,
    files: ['lib/index.js', ...invariantFile ? ['lib/invariant.js'] : []],
    peerDependencies: !invariantDependency || developmentOnlyInvariant ? {} : {
      '@deepseek-ai/dsh-invariants': 'workspace:^',
    },
    devDependencies: !invariantDependency ? {} : {
      '@deepseek-ai/dsh-invariants': 'workspace:^',
    },
  }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(dir, 'tsconfig.json'), `${JSON.stringify({
    references: invariantReference ? [{ path: '../../runtime-diagnostics/invariants' }] : [],
  }, null, 2)}\n`)
  if (companion) {
    writeFileSync(join(dir, 'src/invariant.ts'), options.source ?? handwrittenInvariant(packageName))
  }
  writeFileSync(
    join(dir, 'tsdown.config.ts'),
    buildEntry ? "export default { entry: ['lib/types/index.js', 'lib/types/invariant.js'] }\n" : "export default { entry: ['lib/types/index.js'] }\n",
  )
  writeFileSync(
    join(dir, 'README.md'),
    options.omissionReason === false ? '# Probe\n' : '# Probe\n\nNo runtime invariant companion is published because this fixture owns no diverging observations.\n',
  )
  return root
}

describe('package invariant gate', () => {
  it('accepts a hand-owned checking companion with publication metadata', () => {
    expect(collectPackageInvariantViolations(fixture())).toEqual([])
  })

  it('accepts a package that cleanly omits an invariant companion', () => {
    const root = fixture({ companion: false })
    expect(collectPackageInvariantViolations(root)).toEqual([])
    expect(packageInvariantOwners(root)).toEqual([])
  })

  it('requires an omitted companion to have a README reason sentence', () => {
    const violations = collectPackageInvariantViolations(fixture({
      companion: false,
      omissionReason: false,
    }))
    expect(violations).toContainEqual({
      path: 'packages/core/probe/README.md',
      message: 'omitted companion requires a README "No ... companion is published" reason sentence',
    })
  })

  it('accepts development-only invariants for configured Host dependencies', () => {
    expect(collectPackageInvariantViolations(fixture({ packageName: '@deepseek-ai/dsh-llm' }))).toEqual([])
  })

  it('accepts development-only invariants for client packages', () => {
    expect(collectPackageInvariantViolations(fixture({
      packageName: '@deepseek-ai/dsh-client-probe',
      packageDirectory: 'packages/client/probe',
    }))).toEqual([])
  })

  it('accepts development-only invariants for packages with a dsh.client entry', () => {
    expect(collectPackageInvariantViolations(fixture({ clientDeclaration: true, clientExport: true }))).toEqual([])
  })

  it('keeps invariant peers for packages that only export a Client API', () => {
    expect(collectPackageInvariantViolations(fixture({ clientExport: true }))).toEqual([])
  })

  it('keeps invariant peers for experimental packages with a dsh.client entry', () => {
    expect(collectPackageInvariantViolations(fixture({
      packageDirectory: 'packages/experimental/probe',
      clientDeclaration: true,
      clientExport: true,
    }))).toEqual([])
  })

  it('accepts an invariant reference owned by a package-local leaf project', () => {
    const root = fixture({ invariantReference: false })
    const dir = join(root, 'packages/core/probe')
    writeFileSync(join(dir, 'tsconfig.json'), `${JSON.stringify({
      files: [],
      references: [{ path: './tsconfig.host.json' }],
    }, null, 2)}\n`)
    writeFileSync(join(dir, 'tsconfig.host.json'), `${JSON.stringify({
      references: [{ path: '../../runtime-diagnostics/invariants' }],
    }, null, 2)}\n`)

    expect(collectPackageInvariantViolations(root)).toEqual([])
  })

  it('rejects missing publication metadata and build output', () => {
    const violations = collectPackageInvariantViolations(fixture({
      invariantExport: false,
      invariantFile: false,
      invariantDependency: false,
      invariantReference: false,
      buildEntry: false,
    }))
    expect(violations.map(violation => violation.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('exports["./invariant"]'),
      expect.stringContaining('peerDependency'),
      expect.stringContaining('devDependency'),
      expect.stringContaining('TypeScript project references'),
      expect.stringContaining('must bundle lib/types/invariant.js'),
    ]))
  })

  it('rejects publication and build wiring left behind after omission', () => {
    const violations = collectPackageInvariantViolations(fixture({
      companion: false,
      invariantExport: true,
      invariantFile: true,
      invariantReference: true,
      buildEntry: true,
    }))
    expect(violations.map(violation => violation.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('exports["./invariant"] must be omitted'),
      expect.stringContaining('files must omit lib/invariant.js'),
      expect.stringContaining('TypeScript project references must omit ../../runtime-diagnostics/invariants'),
      expect.stringContaining('build override must omit lib/types/invariant.js'),
    ]))
  })

  it('rejects foreign, duplicate, and unresolved registrations', () => {
    const source = `
export const name = 'probe-invariant'
export const inject = ['invariants']
const selected = process.env.PACKAGE_NAME
const install = (_ctx: unknown, fail: (message: string) => never) => { fail('probe') }
export const apply = (ctx: { invariants: { register(name: string, install: typeof install): () => void } }) => {
  ctx.invariants.register('@deepseek-ai/dsh-foreign', install)
  return ctx.invariants.register(selected!, install)
}
`
    const violations = collectPackageInvariantViolations(fixture({ source }))
    expect(violations.map(violation => violation.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('must resolve to a local string constant'),
      expect.stringContaining('must register exactly its own package name'),
    ]))
  })

  it('rejects generated markers and reporter-free executable installers', () => {
    const generated = fixture({
      source: `/** @generated */\n${handwrittenInvariant('@deepseek-ai/dsh-probe')}`,
    })
    expect(collectPackageInvariantViolations(generated).map(violation => violation.message))
      .toContain('invariant companions must be hand-owned and may not carry @generated markers')

    const reporterFree = fixture({
      source: `
export const name = 'probe-invariant'
export const inject = ['invariants']
const install = () => { void 0 }
export const apply = (ctx: { invariants: { register(name: string, install: typeof install): () => void } }) =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-probe', install))
`,
    })
    expect(collectPackageInvariantViolations(reporterFree).map(violation => violation.message))
      .toContain('install function must accept the bound failure reporter as its second parameter')

    const unused = fixture({
      source: `
export const name = 'probe-invariant'
export const inject = ['invariants']
const install = (_ctx: unknown, _fail: (message: string) => never) => { void 0 }
export const apply = (ctx: { invariants: { register(name: string, install: typeof install): () => void } }) =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-probe', install))
`,
    })
    expect(collectPackageInvariantViolations(unused).map(violation => violation.message))
      .toContain('install function must use its bound failure reporter')
  })

  it('rejects registering a different installer than the checked local function', () => {
    const decoy = fixture({
      source: `
export const name = 'probe-invariant'
export const inject = ['invariants']
const install = (_ctx: unknown, fail: (message: string) => never) => { fail('checked decoy') }
export const apply = (ctx: { invariants: { register(name: string, install: () => void): () => void } }) =>
  ctx.invariants.register('@deepseek-ai/dsh-probe', () => {})
`,
    })
    expect(collectPackageInvariantViolations(decoy).map(violation => violation.message))
      .toContain('line 6: ctx.invariants.register must use the checked local install function')
  })

  it.each([
    'export default { name, inject, apply }',
    "export * as default from './probe.ts'",
  ])('rejects a default export that would collapse the Loader namespace', (defaultExport) => {
    const source = `${handwrittenInvariant('@deepseek-ai/dsh-probe')}\n${defaultExport}\n`
    expect(collectPackageInvariantViolations(fixture({ source })).map(violation => violation.message))
      .toContain('must not default-export; Loader must retain the companion namespace')
  })

  it('rejects empty installers because packages without a check omit the companion', () => {
    const source = `
export const name = 'probe-invariant'
export const inject = ['invariants']
const PACKAGE_NAME = '@deepseek-ai/dsh-probe'
const install = () => {}
export const apply = (ctx: { invariants: { register(name: string, install: () => void): () => void } }) =>
  ctx.invariants.register(PACKAGE_NAME, install)
`
    expect(collectPackageInvariantViolations(fixture({ source })).map(violation => violation.message))
      .toContain('empty install function is unnecessary; omit the companion and its publication wiring')
  })
})
