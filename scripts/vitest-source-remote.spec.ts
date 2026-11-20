/** Remote tests resolve source-generated contributions independently of package build output. */
import { cpSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { sourceRemotePlugin } from './vitest-source-remote.ts'
import { removeFixtureSafely } from './test-fixture-cleanup.ts'
import { DEPENDENT_TYPERT_SOURCE, writeCompiledDependency, writeTypertWorkspace } from './typert-workspace.fixture.ts'

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-source-remote-'))
  onTestFinished(() => { removeFixtureSafely(root) })
  return root
}

describe('source Remote test modules', () => {
  it('loads executable Remote metadata from an unbuilt Host and leaves other imports alone', () => {
    const root = temporaryRoot()
    cpSync(resolve(import.meta.dirname, '../packages/typert/generator/tests/fixtures/remote-model'), root, { recursive: true })
    const plugin = sourceRemotePlugin(root, '@fixture/remote')
    const id = plugin.resolveId('@fixture/remote/remote')!
    expect(id).not.toContain('\\')
    expect(plugin.resolveId('@fixture/domain')).toBeUndefined()
    expect(plugin.load('unrelated')).toBeUndefined()
    expect(existsSync(join(root, 'packages/remote/lib'))).toBe(false)

    const code = plugin.load(id)

    expect(code).toContain("'goals/create'")
    expect(code).toContain('createTypertRemoteInfo')
    expect(plugin.load(id)).toBe(code)
    expect(existsSync(join(root, 'packages/remote/lib'))).toBe(false)
  })

  it.each(['@fixture/missing', '@fixture/probe'])('refuses %s without Host Remote methods', (name) => {
    const root = temporaryRoot()
    writeTypertWorkspace(root)
    const plugin = sourceRemotePlugin(root, name)
    expect(() => plugin.load(plugin.resolveId(`${name}/remote`)!)).toThrow(`${name} has no Host Remote contribution`)
  })

  it.each([false, true])('refuses a workspace import without a source alias (built: %s)', (compiled) => {
    const root = temporaryRoot()
    writeTypertWorkspace(root, DEPENDENT_TYPERT_SOURCE)
    writeCompiledDependency(root, compiled)
    const plugin = sourceRemotePlugin(root, '@fixture/probe')
    expect(() => plugin.load(plugin.resolveId('@fixture/probe/remote')!))
      .toThrow('@fixture/dep/types')
  })
})
