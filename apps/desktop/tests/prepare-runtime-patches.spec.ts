import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import yaml from 'js-yaml'
import { pnpmCommand } from '../../../scripts/release/process.ts'
import { prepareRuntimePatches, verifyRuntimePatches } from '../scripts/prepare-runtime-patches.ts'
import type { DesktopRuntimePatch } from '../scripts/runtime-patch-policy.ts'

const roots: string[] = []
const shared = { scope: 'shared', reason: 'Runtime fixture.' } as const
const excluded = { scope: 'workspace-only', reason: 'Build fixture.' } as const
const patch = 'diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-original\n+patched\n'
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function fixture(): { root: string; source: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), 'desktop-patch-policy-'))
  roots.push(root)
  const source = join(root, 'source')
  const project = join(root, 'project')
  mkdirSync(source)
  mkdirSync(project)
  writeFileSync(join(source, 'shared.patch'), patch)
  writeFileSync(join(source, 'private.patch'), patch.replace('+patched', '+private'))
  writeFileSync(join(source, 'pnpm-workspace.yaml'), yaml.dump({ patchedDependencies: { 'fixture@1.0.0': 'shared.patch' } }))
  writeFileSync(join(source, 'pnpm-lock.yaml'), yaml.dump({
    patchedDependencies: { 'fixture@1.0.0': createHash('sha256').update(patch).digest('hex') },
  }))
  writeFileSync(join(project, 'pnpm-workspace.yaml'), yaml.dump({
    packages: ['.'], nodeLinker: 'hoisted', overrides: { internal: 'file:./internal.tgz' }, allowBuilds: { fixture: false },
  }))
  return { root, source, project }
}

it('classifies the current workspace and shares only runtime patch bytes', () => {
  const { project } = fixture()
  const repository = resolve(import.meta.dirname, '../../..')
  const before = readFileSync(join(repository, 'pnpm-lock.yaml'))
  const plan = prepareRuntimePatches(project, repository)
  expect(plan.patches.map(entry => entry.spec)).toEqual(['@earendil-works/pi-ai@1.0.2', 'node-pty@1.2.0-beta.15'])
  expect(plan.workspaceOnly).toHaveLength(5)
  const settings = yaml.load(readFileSync(join(project, 'pnpm-workspace.yaml'), 'utf8')) as { overrides: Record<string, string> }
  expect(settings.overrides['@earendil-works/pi-ai']).toBeUndefined()
  expect(settings.overrides['@earendil-works/pi-ai@^1.0.2']).toBe('1.0.2')
  expect(readFileSync(join(repository, 'pnpm-lock.yaml'))).toEqual(before)
})

it('does not infer version overrides from selected patches', () => {
  const { source, project } = fixture()
  const before = readFileSync(join(source, 'pnpm-workspace.yaml'))
  prepareRuntimePatches(project, source, { 'fixture@1.0.0': shared }, {})
  expect(yaml.load(readFileSync(join(project, 'pnpm-workspace.yaml'), 'utf8'))).toMatchObject({
    overrides: { internal: 'file:./internal.tgz' }, allowBuilds: { fixture: false },
  })
  expect(readFileSync(join(source, 'pnpm-workspace.yaml'))).toEqual(before)
  expect(readFileSync(join(project, 'patches/desktop-0.patch'), 'utf8')).toBe(patch)
})

it('supports an independent runtime patch for a package also patched in the workspace', () => {
  const { source, project } = fixture()
  const plan = prepareRuntimePatches(project, source, {
    'fixture@1.0.0': { scope: 'runtime-only', path: 'private.patch', reason: 'Different runtime layout.' },
    'other@2.0.0': { scope: 'runtime-only', path: 'private.patch', reason: 'Runtime-only dependency.' },
  }, {})
  expect(plan.patches).toHaveLength(2)
  expect(readFileSync(join(project, plan.patches[0]!.path), 'utf8')).toContain('+private')
  expect(readFileSync(join(source, 'shared.patch'), 'utf8')).toBe(patch)
})

it.each([
  { policy: {}, message: 'classify the workspace patch' },
  { policy: { 'fixture@1.0.0': shared, 'absent@1.0.0': shared }, message: 'stale workspace patch decision' },
  { policy: { 'fixture@1.0.0': { scope: 'runtime-only', path: '../outside.patch', reason: 'Invalid path.' } }, message: 'inside the repository' },
  { policy: { 'fixture@1.0.0': { scope: 'runtime-only', path: 'missing.patch', reason: 'Missing file.' } }, message: 'ENOENT' },
] satisfies Array<{ policy: Record<string, DesktopRuntimePatch>; message: string }>)('rejects invalid selection: $message', ({ policy, message }) => {
  const { source, project } = fixture()
  expect(() => { prepareRuntimePatches(project, source, policy, {}) }).toThrow(message)
})

it('rejects shared bytes that differ from the workspace lockfile', () => {
  const { source, project } = fixture()
  writeFileSync(join(source, 'shared.patch'), patch + '\n')
  expect(() => { prepareRuntimePatches(project, source, { 'fixture@1.0.0': shared }, {}) }).toThrow('root lockfile')
})

it('refuses to write to the workspace or replace an unrelated existing override', () => {
  const { source, project } = fixture()
  expect(() => { prepareRuntimePatches(source, source, { 'fixture@1.0.0': shared }, {}) }).toThrow('source workspace')
  expect(() => { prepareRuntimePatches(project, source, { 'fixture@1.0.0': shared }, { internal: '2.0.0' }) }).toThrow('conflicting')
})

it.each(['version', 'lock hash', 'file bytes', 'workspace-only', 'unused'] as const)('rejects invalid resolved installation: %s', (failure) => {
  const { source, project } = fixture()
  const plan = prepareRuntimePatches(project, source, { 'fixture@1.0.0': failure === 'workspace-only' ? excluded : shared }, {})
  writeFileSync(join(project, 'pnpm-lock.yaml'), yaml.dump({
    patchedDependencies: Object.fromEntries(plan.patches.map(entry => [entry.spec, failure === 'lock hash' ? 'wrong' : entry.hash])),
    packages: failure === 'unused' ? {} : { [failure === 'version' ? 'fixture@1.0.1' : 'fixture@1.0.0']: {} },
  }))
  if (failure === 'file bytes') writeFileSync(join(project, plan.patches[0]!.path), 'changed')
  expect(() => { verifyRuntimePatches(project, plan) }).toThrow(/desktop patches:/u)
})

it.each([false, true])('pnpm applies runtime-only bytes and rejects an inapplicable patch (invalid=%s)', async (invalid) => {
  const { source, project, root } = fixture()
  const packageDir = join(root, 'package')
  mkdirSync(packageDir)
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }))
  writeFileSync(join(packageDir, 'value.txt'), 'original\n')
  const run = promisify(execFile)
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    /^(?:path|systemroot|windir|comspec|temp|tmp)$/iu.test(name)
  )))
  await run('tar', ['-czf', 'fixture.tgz', '-C', root, 'package'], { cwd: project, env, timeout: 15_000, windowsHide: true })
  writeFileSync(join(project, 'package.json'), JSON.stringify({ private: true, dependencies: { fixture: 'file:./fixture.tgz' } }))
  writeFileSync(join(project, 'npmrc'), '')
  if (invalid) writeFileSync(join(source, 'private.patch'), patch.replace('-original', '-does-not-exist'))
  const plan = prepareRuntimePatches(project, source, {
    'fixture@1.0.0': { scope: 'runtime-only', path: 'private.patch', reason: 'Offline install fixture.' },
  }, {})
  const [command, ...args] = pnpmCommand()
  const install = run(command, [...args, 'install', '--offline', '--ignore-scripts',
    `--config.userconfig=${join(project, 'npmrc')}`, `--config.store-dir=${join(project, 'store')}`,
    '--config.manage-package-manager-versions=false'], { cwd: project, env: { ...env, CI: 'true' }, timeout: 30_000, windowsHide: true })
  if (invalid) {
    const failure: unknown = await install.catch((error: unknown) => error)
    if (!(failure instanceof Error) || !('stdout' in failure)) throw new Error('Expected a captured pnpm failure')
    expect(failure).toHaveProperty('code', 1)
    expect(failure.stdout).toMatch(/PATCH_FAILED/u)
  } else {
    await install
    verifyRuntimePatches(project, plan)
    expect(readFileSync(join(project, 'node_modules/fixture/value.txt'), 'utf8')).toBe('private\n')
  }
  expect(existsSync(join(source, 'node_modules'))).toBe(false)
}, 45_000)
