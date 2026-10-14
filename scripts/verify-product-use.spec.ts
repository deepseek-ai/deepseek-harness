/** Product-use regressions exercise source reachability and effective Loader composition. */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProductPackagePolicy } from './product-package-policy.ts'
import { verifyProductUse } from './verify-product-use.ts'
import { writeFixtureFile as write } from './fixture-file.ts'

const roots: string[] = []
const base = '@deepseek-ai/dsh-base'
const core = '@deepseek-ai/dsh-core'
const candidate = '@deepseek-ai/dsh-candidate'
const candidateDir = 'packages/core/candidate'
const profile = 'packages/boot/app-boot/src/profile.ts'
const catalog = 'packages/boot/app-boot/src/official-bundle-packages.ts'
const patch = 'packages/bundle/base/cordis.patch.yml'

function pkg(root: string, directory: string, name: string, fields: Record<string, unknown> = {}): void {
  write(root, `${directory}/package.json`, { name, ...fields })
  write(root, `${directory}/src/index.ts`, 'export {}\n')
  const config = JSON.parse(readFileSync(join(root, 'tsconfig.base.json'), 'utf8')) as {
    compilerOptions: { paths: Record<string, string[]> }
  }
  config.compilerOptions.paths[name] = [`./${directory}/src/index.ts`]
  config.compilerOptions.paths[`${name}/*`] = [`./${directory}/src/*.ts`]
  write(root, 'tsconfig.base.json', config)
}

function profiles(root: string, optional: string[] = [], onDemand: string[] = []): void {
  write(root, catalog, `export const ON_DEMAND_BUNDLES = ${JSON.stringify(onDemand)}\n`)
  write(root, profile, `export const PROFILE_TEMPLATES = ${JSON.stringify(Object.fromEntries(
    ['web', 'acp', 'headless', 'sdk', 'sdk-minimal'].map(name => [name, { bundles: [base] }]),
  ))}\nexport const DEFAULT_PROFILE_BUNDLES = ['${base}']\nexport const OPTIONAL_BUNDLES = ${JSON.stringify(optional)}\n`)
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-product-use-'))
  roots.push(root)
  write(root, 'tsconfig.base.json', { compilerOptions: { moduleResolution: 'bundler', paths: {} } })
  pkg(root, 'apps/cli', '@deepseek-ai/dsh')
  pkg(root, 'apps/desktop', '@fixture/desktop')
  pkg(root, 'apps/web', '@fixture/web')
  write(root, 'apps/cli/src/bin.ts', 'export {}\n')
  write(root, 'apps/desktop/src/main.ts', 'export {}\n')
  write(root, 'apps/web/src/main.ts', 'export {}\n')
  write(root, 'apps/web/index.html', '<script type="module" src="/src/main.ts"></script>')
  pkg(root, 'packages/bundle/base', base, { dsh: { bundle: { patch: './cordis.patch.yml' } } })
  pkg(root, 'packages/core/core', core)
  write(root, patch, [{ insert: [{ id: 'core', name: core }] }])
  profiles(root)
  return root
}

function declarations(category: ProductPackagePolicy['category'] = 'optional'): Record<string, ProductPackagePolicy> {
  return { [candidateDir]: { category, reason: 'Selected by the operator.' } }
}

function failures(root: string, policy: Record<string, ProductPackagePolicy> = {}): string {
  return verifyProductUse(root, policy).failures.join('\n')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('product package use', () => {
  it('accepts a complete effective composition without build outputs', () => {
    expect(verifyProductUse(fixture(), {})).toMatchObject({ failures: [], optionalPackages: [], configCount: 1 })
  })

  it('rejects an orphan even when an app manifest installs it', () => {
    const root = fixture()
    pkg(root, candidateDir, candidate)
    write(root, 'apps/cli/package.json', { name: '@deepseek-ai/dsh', dependencies: { [candidate]: '*' } })
    expect(failures(root)).toContain(`${candidateDir} (${candidate}): no product runtime use`)
    expect(failures(root, declarations())).toBe('')
  })

  it.each([
    `import type { Shape } from '${candidate}'`,
    `import { type Shape } from '${candidate}'`,
    `export type * from '${candidate}'`,
    `type Shape = import('${candidate}').Shape`,
  ])('does not count type-only source: %s', (source) => {
    const root = fixture()
    pkg(root, candidateDir, candidate)
    write(root, 'apps/cli/src/bin.ts', source)
    expect(failures(root)).toContain('no product runtime use')
  })

  it.each([
    `import '${candidate}'`, `export * from '${candidate}'`,
    `await import('${candidate}')`, `const value = require('${candidate}')`,
  ])('follows runtime source: %s', (source) => {
    const root = fixture()
    pkg(root, candidateDir, candidate)
    write(root, 'apps/cli/src/bin.ts', source)
    expect(failures(root)).toBe('')
    expect(failures(root, declarations())).toContain('stale optional policy')
  })

  it('assigns relative cross-package imports to one source owner on every platform', () => {
    const root = fixture()
    const baseline = verifyProductUse(root, {}).sourceCount
    pkg(root, candidateDir, candidate)
    write(root, 'apps/cli/src/bin.ts', "import '../../../packages/core/candidate/src/index.ts'")
    expect(verifyProductUse(root, {})).toMatchObject({ failures: [], sourceCount: baseline + 1 })
    write(root, 'apps/cli/src/bin.ts', `import '../../../packages/core/candidate/src/index.ts'\nimport '${candidate}'`)
    expect(verifyProductUse(root, {})).toMatchObject({ failures: [], sourceCount: baseline + 1 })
  })

  it('follows only reached local modules, including cycles and worker URLs', () => {
    const root = fixture()
    pkg(root, candidateDir, candidate)
    write(root, 'apps/cli/src/unreachable.ts', `import '${candidate}'`)
    expect(failures(root)).toContain('no product runtime use')
    write(root, 'apps/cli/src/bin.ts', "import './cycle.ts'\nnew URL('./worker.js', import.meta.url)")
    write(root, 'apps/cli/src/cycle.ts', "import './bin.ts'")
    write(root, 'apps/cli/src/worker.ts', `import '${candidate}'`)
    expect(failures(root)).toBe('')
  })

  it.each(['apps/desktop/src/main.ts', 'apps/web/src/main.ts'])('reaches the %s entrypoint', (entry) => {
    const root = fixture()
    pkg(root, candidateDir, candidate)
    write(root, entry, `import '${candidate}'`)
    expect(failures(root)).toBe('')
  })

  it.each(['acp', 'headless', 'sdk', 'sdk-minimal'])('composes the %s profile independently', (name) => {
    const root = fixture()
    pkg(root, candidateDir, candidate, { dsh: { bundle: { patch: './feature.patch.yml' } } })
    write(root, `${candidateDir}/feature.patch.yml`, [{ insert: [{ name: candidate }] }])
    const source = readFileSync(join(root, profile), 'utf8')
    write(root, profile, source.replace(`"${name}":{"bundles":["${base}"]}`, `"${name}":{"bundles":["${base}","${candidate}"]}`))
    expect(failures(root)).toBe('')
  })

  it.each([true, false])('excludes disabled Include children with initial=%s', (initial) => {
    const root = fixture()
    pkg(root, candidateDir, candidate)
    const children = [{ name: candidate }]
    if (!initial) write(root, 'packages/boot/app-boot/src/included.yml', children)
    write(root, patch, [{ insert: [{ name: core }, {
      name: 'cordis:include', disabled: true, config: { path: './included.yml', ...(initial ? { initial: children } : {}) },
    }] }])
    expect(failures(root)).toContain('no product runtime use')
  })

  it('honors disabled groups, presets, nested initial entries, and conditional disabled expressions', () => {
    const root = fixture()
    pkg(root, candidateDir, candidate)
    write(root, patch, [{ insert: [{ name: core }, { group: true, disabled: true, config: [{ name: candidate }] },
      { name: 'cordis:include', config: { path: './missing.yml', initial: [{ disabled: true, group: true, config: [{ name: candidate }] }] } }] }])
    expect(failures(root)).toContain('no product runtime use')
    write(root, patch, `- insert:\n    - name: '${core}'\n    - name: '${candidate}'\n      disabled: !!js process.platform === 'win32'\n`)
    expect(failures(root)).toBe('')
  })

  it('applies Include patches before collecting runtime mounts and uses files ahead of initial entries', () => {
    const root = fixture()
    pkg(root, candidateDir, candidate)
    write(root, 'packages/boot/app-boot/src/included.yml', [{ id: 'child', name: candidate }])
    write(root, patch, [{ insert: [{ name: core }, { name: 'cordis:include', config: {
      path: './included.yml', initial: [{ name: candidate }], patches: [{ id: 'child', disabled: true }],
    } }] }])
    expect(failures(root)).toContain('no product runtime use')
    write(root, 'packages/boot/app-boot/src/included.yml', [])
    expect(failures(root)).toContain('no product runtime use')
  })

  it('ignores unmatched insertions and later replaced or disabled rows', () => {
    const root = fixture()
    pkg(root, candidateDir, candidate)
    write(root, patch, [
      { insert: [{ id: 'root', group: true, config: [{ name: candidate }] }, { id: 'candidate', name: candidate }, { name: core }] },
      { id: 'missing', insert: [{ name: candidate }] },
      { id: 'root', config: [] }, { id: 'candidate', disabled: true },
    ])
    expect(failures(root)).toContain('no product runtime use')
  })

  it('visits nested preset entries only while the preset is enabled', () => {
    const root = fixture()
    pkg(root, candidateDir, candidate)
    pkg(root, 'packages/preset/agent-preset', '@deepseek-ai/dsh-agent-preset')
    const entry = { id: 'preset', name: '@deepseek-ai/dsh-agent-preset', config: {
      id: 'standard', plugins: [{ group: true, config: [{ name: candidate }] }],
    } }
    write(root, patch, [{ insert: [{ name: core }, entry] }])
    expect(failures(root)).toBe('')
    write(root, patch, [{ insert: [{ name: core }, entry] }, { id: 'preset', disabled: true }])
    expect(failures(root)).toContain(`${candidateDir} (${candidate}): no product runtime use`)
  })

  it.each(['shipped', 'on-demand'])('keeps %s optional selection and its runtime closure separate from default use', (delivery) => {
    const root = fixture()
    const bundle = '@deepseek-ai/dsh-experimental-feature'
    pkg(root, 'packages/experimental/feature', bundle, { dsh: { bundle: { patch: './cordis.patch.yml' } } })
    pkg(root, candidateDir, candidate)
    pkg(root, 'packages/core/indirect', '@deepseek-ai/dsh-indirect')
    write(root, `${candidateDir}/src/index.ts`, "import '@deepseek-ai/dsh-indirect'")
    write(root, 'packages/experimental/feature/cordis.patch.yml', [{ insert: [{ name: candidate }] }])
    profiles(root, delivery === 'shipped' ? [bundle] : [], delivery === 'on-demand' ? [bundle] : [])
    const result = verifyProductUse(root, declarations())
    expect(result.failures).toEqual([])
    expect(result.optionalPackages).toEqual([candidateDir, 'packages/core/indirect', 'packages/experimental/feature'])
    expect(result.defaultPackages).not.toContain(candidateDir)
  })

  it.each(['shipped', 'on-demand'])('does not count a %s optional patch whose target is absent', (delivery) => {
    const root = fixture()
    const bundle = '@deepseek-ai/dsh-experimental-feature'
    pkg(root, 'packages/experimental/feature', bundle, { dsh: { bundle: { patch: './cordis.patch.yml' } } })
    pkg(root, candidateDir, candidate)
    write(root, 'packages/experimental/feature/cordis.patch.yml', [{ id: 'absent', insert: [{ name: candidate }] }])
    profiles(root, delivery === 'shipped' ? [bundle] : [], delivery === 'on-demand' ? [bundle] : [])
    expect(failures(root)).toContain('no product runtime use')
  })

  it('counts declared generated Remote metadata without loading an artifact or its Host implementation', () => {
    const root = fixture()
    pkg(root, candidateDir, candidate, { exports: { './remote': {
      types: './lib/typert.remote-client.d.ts', default: './lib/typert.remote-client.js',
    } } })
    pkg(root, 'packages/core/host-only', '@deepseek-ai/dsh-host-only')
    write(root, `${candidateDir}/src/index.ts`, "import '@deepseek-ai/dsh-host-only'")
    write(root, 'apps/web/src/main.ts', `import '${candidate}/remote'`)
    const result = verifyProductUse(root, {})
    expect(result.defaultPackages).toContain(candidateDir)
    expect(result.defaultPackages).not.toContain('packages/core/host-only')
    expect(result.failures).toEqual([
      'packages/core/host-only (@deepseek-ai/dsh-host-only): no product runtime use; mount it, declare its maintained role, or move it to experimental',
    ])
  })

  it('rejects an on-demand catalog entry without an installable bundle declaration', () => {
    const root = fixture()
    pkg(root, candidateDir, candidate)
    profiles(root, [], [candidate])
    expect(failures(root, declarations())).toContain(`${candidate} must declare dsh.bundle.patch`)
  })

  it('rejects a missing workspace source mapping instead of consulting built exports', () => {
    const root = fixture()
    pkg(root, candidateDir, candidate)
    write(root, 'apps/cli/src/bin.ts', `import '${candidate}/missing'`)
    expect(failures(root)).toContain('does not resolve to workspace source')
  })

  it('resolves an inserted relative plugin beside its declaring bundle', () => {
    const root = fixture()
    pkg(root, candidateDir, candidate)
    write(root, 'packages/bundle/base/local.ts', `import '${candidate}'`)
    write(root, patch, [{ insert: [{ name: core }, { name: './local.ts' }] }])
    expect(failures(root)).toBe('')
  })

  it('follows explicit directory-picker dynamic mounts and their client face', () => {
    const root = fixture()
    const picker = '@deepseek-ai/dsh-host-directory-picker-auto'
    pkg(root, 'packages/host/directory-picker-auto', picker)
    pkg(root, candidateDir, candidate, { dsh: { client: { platform: 'web' } } })
    pkg(root, 'packages/client/indirect', '@deepseek-ai/dsh-client-indirect')
    write(root, `${candidateDir}/src/client.ts`, "import '@deepseek-ai/dsh-client-indirect'")
    write(root, 'packages/host/directory-picker-auto/src/index.ts',
      `export const BACKEND_PACKAGES = { native: '${candidate}' }\nexport const SURFACE_PACKAGES = { native: '${candidate}' }\n`)
    write(root, patch, [{ insert: [{ name: core }, { name: picker }] }])
    expect(failures(root)).toBe('')
  })

  it('accepts declaration-only infrastructure and rejects missing or miscategorized policy entries', () => {
    const root = fixture()
    const directory = 'packages/util/package-manifest'
    pkg(root, directory, '@deepseek-ai/dsh-package-manifest')
    expect(failures(root)).toContain(`${directory} (@deepseek-ai/dsh-package-manifest): no product runtime use`)
    expect(failures(root, { [directory]: { category: 'declarations', reason: 'Shared public metadata types.' } })).toBe('')
    pkg(root, candidateDir, candidate)
    expect(failures(root, declarations('declarations'))).toContain('invalid policy category declarations')
    expect(failures(root, { 'packages/core/missing': { category: 'optional', reason: 'Missing.' } })).toContain('stale package policy')
  })

  it('requires a declared Web distribution package to remain source-reachable', () => {
    const root = fixture()
    const directory = 'packages/client/web'
    const name = '@deepseek-ai/dsh-client-web'
    pkg(root, directory, name)
    const policy = { [directory]: { category: 'web-distribution', reason: 'Browser boot kernel.' } } as const
    expect(failures(root, policy)).toContain('stale web-distribution policy')
    write(root, 'apps/web/src/main.ts', `import '${name}'`)
    expect(failures(root, policy)).toBe('')
  })

  it('fails when the shipped profile corpus is narrowed', () => {
    const root = fixture()
    const source = readFileSync(join(root, profile), 'utf8')
    write(root, profile, source.replace(/"acp":\{"bundles":\[[^\]]+\]\},/, ''))
    expect(failures(root)).toContain('missing shipped acp profile')
  })
})
