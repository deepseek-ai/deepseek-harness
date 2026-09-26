/** Explicit CLI exemptions use the profile lock and never become pnpm arguments. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { getDshRuntimeVersion, readProfileVersionExemptions } from '@deepseek-ai/dsh-app-boot'
import { runPluginCommand } from '@deepseek-ai/dsh-plugin-manager/operations'
import { runPlugin } from '../src/plugin.ts'

vi.mock('../src/profile-boot.ts', () => ({ INSTALL_ANCHOR: '/installation/package.json' }))
vi.mock('@deepseek-ai/dsh-plugin-manager/operations', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-plugin-manager/operations')>(),
  runPluginCommand: vi.fn(),
}))

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'cli-version-exemptions-'))
  vi.stubEnv('DSH_HOME', home)
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  onTestFinished(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.mocked(runPluginCommand).mockReset()
    rmSync(home, { recursive: true, force: true })
  })
  return { dir: join(home, 'profiles', 'test'), stdout, stderr }
}

it('requires explicit acknowledgement, grants only the exact pair, lists and revokes it without pnpm', async () => {
  const { dir, stdout, stderr } = fixture()
  const runtime = getDshRuntimeVersion()
  expect(await runPlugin('test', ['allow-version', '@example/plugin@1.2.3', '--dsh-version', runtime, '--accept-risk'])).toBe(0)
  expect(stderr.mock.calls.map(call => call[0]).join('')).toMatchInlineSnapshot(`
    "dsh: warning: allowing incompatible plugin versions can break the application or corrupt data. Approval applies only to the exact package and DSH versions.
    "
  `)
  expect(stderr.mock.invocationCallOrder[0]).toBeLessThan(stdout.mock.invocationCallOrder[0]!)
  expect(readProfileVersionExemptions(dir)).toEqual({ '@example/plugin@1.2.3': [runtime] })
  expect(JSON.parse(readFileSync(join(dir, 'compatibility.json'), 'utf8'))).toEqual({ '@example/plugin@1.2.3': [runtime] })
  expect(await runPlugin('test', ['version-exemptions'])).toBe(0)
  expect(stdout).toHaveBeenLastCalledWith(JSON.stringify({ '@example/plugin@1.2.3': [runtime] }, undefined, 2) + '\n')
  expect(await runPlugin('test', ['revoke-version', '@example/plugin@1.2.3', `--dsh-version=${runtime}`])).toBe(0)
  expect(readProfileVersionExemptions(dir)).toEqual({})
  expect(runPluginCommand).not.toHaveBeenCalled()
})

it.each([
  ['allow-version', 'plugin@1.2.3', '--dsh-version', 'CURRENT'],
  ['allow-version', 'plugin@1.2.3', '--accept-risk'],
  ['allow-version', 'plugin@^1.2.3', '--dsh-version', 'CURRENT', '--accept-risk'],
  ['allow-version', 'plugin@1.2.3', '--dsh-version', '999.0.0', '--accept-risk'],
  ['allow-version', 'plugin@1.2.3', '--dsh-version', 'CURRENT', '--accept-risk=false'],
  ['allow-version', 'plugin@1.2.3', '--dsh-version', 'CURRENT', '--accept-risk', '--accept-risk'],
  ['revoke-version', 'plugin@1.2.3'],
  ['version-exemptions', 'extra'],
])('rejects malformed or unacknowledged exemption command %j', async (...arguments_) => {
  const { dir, stderr } = fixture()
  const args = arguments_.map(value => value === 'CURRENT' ? getDshRuntimeVersion() : value)
  expect(await runPlugin('test', args)).toBe(1)
  expect(stderr).toHaveBeenCalled()
  expect(existsSync(join(dir, 'compatibility.json'))).toBe(false)
  expect(runPluginCommand).not.toHaveBeenCalled()
})

it('uses shipped profile defaults when listing a missing profile', async () => {
  fixture()
  expect(await runPlugin('web', ['version-exemptions'])).toBe(0)
  expect(runPluginCommand).not.toHaveBeenCalled()
})

it.each([0, 1])('forwards ordinary pnpm output and exit status %s', async (exitCode) => {
  const { stdout, stderr } = fixture()
  vi.mocked(runPluginCommand).mockImplementation(async (_context, _args, options) => {
    options.onOutput?.('pnpm output', 'stdout')
    return { exitCode, output: '', truncated: false, logPath: '/profile/log' }
  })
  expect(await runPlugin('test', ['list'])).toBe(exitCode)
  expect(stdout).toHaveBeenCalledWith('pnpm output')
  if (exitCode === 0) expect(stderr).not.toHaveBeenCalled()
  else expect(stderr).toHaveBeenCalledWith('dsh: plugin command failed; diagnostics: /profile/log\n')
})

it('names the exact grant command for each package a compatibility check refused', async () => {
  const { stderr } = fixture()
  vi.mocked(runPluginCommand).mockResolvedValue({
    exitCode: 1, output: '', truncated: false, logPath: '/profile/log',
    incompatible: [{ name: '@example/plugin', version: '1.2.3', runtimeVersion: '0.1.0', peers: { '@deepseek-ai/dsh': '^9.0.0' } }],
  })
  expect(await runPlugin('test', ['add', '@example/plugin'])).toBe(1)
  expect(stderr.mock.calls.map(call => call[0])).toEqual([
    'dsh: to accept the risk, run: dsh plugin --profile test allow-version @example/plugin@1.2.3 --dsh-version 0.1.0 --accept-risk\n',
    'dsh: plugin command failed; diagnostics: /profile/log\n',
  ])
})

it('forwards all other commands unchanged and retains package diagnostics', async () => {
  const { stderr } = fixture()
  vi.mocked(runPluginCommand).mockResolvedValue({ exitCode: 127, output: '', truncated: false, logPath: '/profile/log' })
  const args = ['add', 'github:example/plugin']
  expect(await runPlugin('test', args)).toBe(127)
  expect(runPluginCommand).toHaveBeenCalledWith(expect.objectContaining({ profile: 'test' }), args, expect.objectContaining({ execution: 'cli' }))
  expect(stderr.mock.calls.map(call => call[0]).join('')).toContain('pnpm was not found')
})
