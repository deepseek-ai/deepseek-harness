import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { typertPlugin } from '../src/tsdown-plugin.ts'
import { WorkspaceTypertGenerator } from '../src/workspace.ts'

const fixtureRoot = resolve(import.meta.dirname, 'fixtures/type-model')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('typertPlugin workspace Worker Thread', { timeout: 120_000 }, () => {
  it('writes the artifacts in-process generation produces', async () => {
    const root = copyFixture('typert-worker-artifacts-')
    const expected = new WorkspaceTypertGenerator(root, { checkDiagnostics: false }).generateContributors()
    const plugin = typertPlugin({ mode: 'workspace' })

    plugin.buildStart({ cwd: join(root, 'packages/host') })
    await plugin.writeBundle({ dir: join(root, 'packages/client/lib') })

    expect(expected.map(artifact => `${artifact.package}:${artifact.face}`))
      .toEqual(['@fixture/host:host', '@fixture/client:client'])
    for (const artifact of expected) {
      const output = join(root, artifact.packageRoot, 'lib')
      expect(readFileSync(join(output, `typert.${artifact.face}.js`), 'utf8')).toBe(artifact.js)
      expect(readFileSync(join(output, `typert.${artifact.face}.d.ts`), 'utf8')).toBe(artifact.dts)
    }
  })

  it('fails the bundle with the analysis error raised in the worker', async () => {
    const root = copyFixture('typert-worker-failure-')
    const manifestPath = join(root, 'packages/host/package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.files = ['lib/typert.host.d.ts']
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    await expect(typertPlugin({ mode: 'workspace', faces: ['host'] }).writeBundle({ dir: join(root, 'packages/host/lib') }))
      .rejects.toThrow(/failed: TypertAnalysisError: typert\(host\): @fixture\/host package files must include lib\/typert\.host\.js$/)
  })
})

function copyFixture(prefix: string): string {
  const root = mkdtempSync(join(import.meta.dirname, `.${prefix}`))
  roots.push(root)
  cpSync(fixtureRoot, root, { recursive: true })
  return root
}
