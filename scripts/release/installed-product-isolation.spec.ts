/** Installed-product isolation uses resolved package identities and runtime edges. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyInstalledProductIsolation } from './installed-product-isolation.ts'

const roots: string[] = []
const experimental = '@deepseek-ai/dsh-experimental-example'

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-installed-isolation-'))
  roots.push(root)
  return root
}

function writePackage(root: string, key: string, manifest: Record<string, unknown>): string {
  const directory = join(root, 'node_modules', key)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify({ name: key, ...manifest })}\n`)
  return directory
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('installed default-product isolation', () => {
  it('ignores development dependencies and unrelated installed experimental packages', () => {
    const root = fixture()
    const entry = writePackage(root, '@deepseek-ai/dsh', {
      dependencies: { core: '1.0.0' },
      devDependencies: { [experimental]: '1.0.0' },
    })
    writePackage(root, 'core', { peerDependencies: { '@deepseek-ai/dsh': '1.0.0' } })
    writePackage(root, experimental, {})

    expect(verifyInstalledProductIsolation(entry)).toBe(2)
  })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'])(
    'rejects a transitive experimental %s',
    (section) => {
      const root = fixture()
      const entry = writePackage(root, '@deepseek-ai/dsh', { dependencies: { thirdParty: '1.0.0' } })
      writePackage(root, 'thirdParty', { [section]: { [experimental]: '1.0.0' } })

      expect(() => verifyInstalledProductIsolation(entry)).toThrow(
        `@deepseek-ai/dsh -> thirdParty -> ${experimental}`,
      )
    },
  )

  it('rejects experimental identities hidden behind an installed alias', () => {
    const root = fixture()
    const entry = writePackage(root, '@deepseek-ai/dsh', { dependencies: { safeName: 'file:../prototype' } })
    writePackage(root, 'safeName', { name: experimental })

    expect(() => verifyInstalledProductIsolation(entry)).toThrow(experimental)
  })

  it('rejects experimental npm aliases even when an optional package is omitted', () => {
    const root = fixture()
    const entry = writePackage(root, '@deepseek-ai/dsh', {
      optionalDependencies: { safeName: `npm:${experimental}@1.0.0` },
    })

    expect(() => verifyInstalledProductIsolation(entry)).toThrow(experimental)
  })

  it('follows nested installations rather than an unrelated hoisted package', () => {
    const root = fixture()
    const entry = writePackage(root, '@deepseek-ai/dsh', { dependencies: { core: '1.0.0' } })
    writePackage(root, 'core', {})
    writePackage(entry, 'core', { dependencies: { [experimental]: '1.0.0' } })

    expect(() => verifyInstalledProductIsolation(entry)).toThrow(experimental)
  })

  it('permits missing optional packages and optional peers but rejects missing dependencies', () => {
    const root = fixture()
    const entry = writePackage(root, '@deepseek-ai/dsh', {
      dependencies: { optional: '1.0.0' },
      optionalDependencies: { optional: '1.0.0' },
      peerDependencies: { peer: '1.0.0' },
      peerDependenciesMeta: { peer: { optional: true } },
    })
    expect(verifyInstalledProductIsolation(entry)).toBe(1)
    writePackage(root, '@deepseek-ai/dsh', { dependencies: { missing: '1.0.0' } })
    expect(() => verifyInstalledProductIsolation(entry)).toThrow('dependency is missing')
  })
})
