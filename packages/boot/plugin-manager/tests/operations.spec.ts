/** The CLI and manager share package reconciliation, path anchoring and diagnostics. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { expect, it, onTestFinished, vi } from 'vitest'
import { initProfile, readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { anchorPathSpec, runPluginCommand, runProfilePnpm, viewProfilePackage } from '../src/operations.ts'

const command = vi.hoisted(() => ({ run: vi.fn<(...args: unknown[]) => ReturnType<typeof result>>() }))
vi.mock('execa', () => ({ execa: (...args: unknown[]) => command.run(...args) }))

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'manager-pnpm-'))
  onTestFinished(() => { command.run.mockReset(); rmSync(home, { recursive: true, force: true }) })
  const dir = join(home, 'profiles', 'test')
  const installAnchor = join(home, 'package.json')
  writeFileSync(installAnchor, '{}\n')
  initProfile(dir, [])
  return { home, dir, context: { home, profile: 'test', installAnchor, cwd: home } }
}

function result(
  exitCode: number | undefined, output: string, mutate: () => void = () => {},
  details: { code?: string; shortMessage?: string } = {},
) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const done = Promise.resolve().then(() => {
    mutate()
    stdout.end(output)
    stderr.end()
    return { exitCode, failed: exitCode !== 0, ...details }
  })
  return Object.assign(done, { stdout, stderr })
}

function install(dir: string, name: string) {
  const path = join(dir, 'node_modules', name)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: '1', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(path, 'cordis.patch.yml'), '[]\n')
  const manifest = readProfileManifest('test', dir)
  manifest.dependencies = { ...manifest.dependencies, [name]: '1' }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
}

it('anchors relative package specs without rewriting registry specs', () => {
  expect(anchorPathSpec('.', '/workspace')).toBe(resolve('/workspace'))
  expect(anchorPathSpec('file:../plugin', '/workspace/project')).toBe(`file:${resolve('/workspace/plugin')}`)
  expect(anchorPathSpec('package@1', '/workspace')).toBe('package@1')
})

it('activates newly installed bundles and leaves retained disabled dependencies disabled', async () => {
  const { dir, context } = fixture()
  install(dir, 'disabled')
  command.run.mockImplementationOnce(() => result(0, 'installed', () =>{  install(dir, 'new-bundle') }))
  expect(await runPluginCommand(context, ['add', 'new-bundle'], { execution: 'service', outputBytes: 100 })).toMatchObject({ exitCode: 0 })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['new-bundle'])
  command.run.mockImplementationOnce(() => result(0, 'updated'))
  await runPluginCommand(context, ['update'], { execution: 'service', outputBytes: 100 })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['new-bundle'])
})

it('can install without activation and bounds output while retaining the complete log', async () => {
  const { dir, context } = fixture()
  command.run.mockImplementationOnce(() => result(0, '0123456789', () =>{  install(dir, 'extra') }))
  const outcome = await runProfilePnpm(context, ['add', './extra'], { execution: 'service', outputBytes: 4, activateNewBundles: false })
  expect(outcome).toMatchObject({ exitCode: 0, output: '6789', truncated: true })
  expect(readFileSync(outcome.logPath, 'utf8')).toBe('0123456789')
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual([])
  expect(command.run.mock.calls[0]?.[1]).toEqual(['add', join(context.cwd, 'extra')])
})

it.each([runPluginCommand, runProfilePnpm])('installs into the supplied application profile directory with %s', async (run) => {
  const { home, dir: namedDir, context } = fixture()
  const dir = join(home, 'application', 'profile')
  initProfile(dir, [])
  command.run.mockImplementationOnce(() => result(0, 'installed', () => { install(dir, 'extra') }))
  const outcome = await run({ ...context, dir }, ['add', 'extra'], { execution: 'service', outputBytes: 100 })
  expect(outcome.exitCode).toBe(0)
  expect(command.run.mock.calls[0]?.[2]).toMatchObject({ cwd: dir })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['extra'])
  expect(readProfileManifest('test', namedDir).dependencies).not.toHaveProperty('extra')
  expect(readProfileManifest('test', namedDir).dsh?.profile?.bundles).toEqual([])
})

it('retains partial package-manager changes after failure without activating them', async () => {
  const { dir, context } = fixture()
  command.run.mockImplementationOnce(() => result(1, 'installation failed', () =>{  install(dir, 'partial') }))
  expect(await runProfilePnpm(context, ['add', 'partial'], { execution: 'service', outputBytes: 100 })).toMatchObject({ exitCode: 1 })
  expect(readProfileManifest('test', dir).dependencies).toEqual({ partial: '1' })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual([])
})


it('initializes missing profiles under the same lock and reports initialization', async () => {
  const { home, context } = fixture()
  const messages: string[] = []
  command.run.mockImplementation(() => result(0, ''))
  for (const profile of ['custom', 'web']) {
    await runPluginCommand({ ...context, profile }, ['root'], {
      execution: 'service', outputBytes: 100, lockWaitMs: 1000, onOutput: (text) => { messages.push(text) },
    })
    expect(readProfileManifest('test', join(home, 'profiles', profile)).dsh?.profile?.bundles).toContain('@deepseek-ai/dsh-base')
  }
  expect(messages.filter(text => text.includes('initialized profile'))).toHaveLength(2)
})

it('retains built-in layers, removes deleted dependencies and warns about plain packages', async () => {
  const { context, dir } = fixture()
  install(dir, 'removed')
  const manifest = readProfileManifest('test', dir)
  manifest.dsh = { profile: { bundles: ['builtin', 'removed'] } }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  const messages: string[] = []
  command.run.mockImplementationOnce(() => result(0, '', () => {
    install(dir, 'plain')
    writeFileSync(join(dir, 'node_modules', 'plain', 'package.json'), '{"name":"plain"}')
    const after = readProfileManifest('test', dir)
    delete after.dependencies?.removed
    writeFileSync(join(dir, 'package.json'), JSON.stringify(after))
  }))
  await runPluginCommand(context, ['remove', 'removed'], { execution: 'service', outputBytes: 100, onOutput: (text) => { messages.push(text) } })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['builtin'])
  expect(messages.join('')).toContain('plain dependency')
})

it('preserves a package-manager selected new bundle without adding it twice', async () => {
  const { context, dir } = fixture()
  writeFileSync(join(dir, 'package.json'), '{}')
  command.run.mockImplementationOnce(() => result(0, '', () => {
    install(dir, 'new')
    const manifest = readProfileManifest('test', dir)
    manifest.dsh = { profile: { bundles: ['new'] } }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  }))
  await runProfilePnpm(context, ['add', 'new'], { execution: 'service', outputBytes: 100 })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['new'])
})

it.each([
  { code: 'ENOENT', shortMessage: 'pnpm not found', expected: 127 },
  { code: 'EACCES', shortMessage: undefined, expected: 1 },
])('reports launch failures with a complete log: $code', async ({ code, shortMessage, expected }) => {
  const { context } = fixture()
  command.run.mockImplementationOnce(() => result(undefined, '', () => {}, { code, ...shortMessage === undefined ? {} : { shortMessage } }))
  const outcome = await runProfilePnpm(context, ['root'], { execution: 'service', outputBytes: 4, signal: new AbortController().signal })
  expect(outcome.exitCode).toBe(expected)
  expect(outcome.truncated).toBe(true)
  expect(readFileSync(outcome.logPath, 'utf8')).toBe(shortMessage ?? 'pnpm failed')
})

it('cancels and settles package output when the output consumer fails', async () => {
  const { context } = fixture()
  let cancellation: AbortSignal | undefined
  command.run.mockImplementationOnce((_name, _args, options) => {
    cancellation = (options as { cancelSignal: AbortSignal }).cancelSignal
    const child = result(0, 'text')
    child.stdout.setEncoding('utf8')
    return child
  })
  await expect(runProfilePnpm(context, ['root'], {
    execution: 'service', outputBytes: 100, onOutput() { throw new Error('output destination closed') },
  })).rejects.toThrow('output destination closed')
  expect(cancellation?.aborted).toBe(true)
})

it('preserves an unexpected subprocess rejection after both streams settle', async () => {
  const { context } = fixture()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  stdout.end()
  stderr.end()
  command.run.mockImplementationOnce(() => Object.assign(Promise.reject(new Error('subprocess failed')), { stdout, stderr }))
  await expect(runProfilePnpm(context, ['root'], { execution: 'service', outputBytes: 100 })).rejects.toThrow('subprocess failed')
})


it('handles manifests without dependency or bundle selections', async () => {
  const { context, dir } = fixture()
  command.run.mockImplementationOnce(() => result(0, '', () => { writeFileSync(join(dir, 'package.json'), '{}') }))
  expect(await runProfilePnpm(context, ['root'], { execution: 'service', outputBytes: 100 })).toMatchObject({ exitCode: 0 })
})

it.each(['cli', 'service'] as const)('uses the %s environment and interaction policy', async (execution) => {
  const { context } = fixture()
  const names = ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'DEEPSEEK_API_KEY']
  const originals = names.map(name => process.env[name])
  onTestFinished(() => {
    names.forEach((name, index) => {
      const original = originals[index]
      if (original === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = original
    })
  })
  for (const name of names) process.env[name] = 'fixture-credential'
  command.run.mockImplementationOnce(() => result(0, ''))
  await runPluginCommand(context, ['approve-builds'], { execution, outputBytes: 100 })
  const options = command.run.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv; stdin: string; stdout: string; stderr: string }
  for (const name of names) expect(options.env[name]).toBe(execution === 'cli' ? 'fixture-credential' : undefined)
  expect(options.stdin).toBe(execution === 'cli' ? 'inherit' : 'ignore')
  expect(options.stdout).toBe(execution === 'cli' ? 'inherit' : 'pipe')
  expect(options.stderr).toBe(execution === 'cli' ? 'inherit' : 'pipe')
})

it('settles inherited CLI descriptors without requiring captured streams', async () => {
  const { context } = fixture()
  command.run.mockImplementationOnce(() => Object.assign(
    Promise.resolve({ exitCode: 0, failed: false }), { stdout: null, stderr: null },
  ) as unknown as ReturnType<typeof result>)
  expect(await runPluginCommand(context, ['approve-builds'], { execution: 'cli', outputBytes: 100 })).toMatchObject({ exitCode: 0, output: '' })
})

it('asks the registry through pnpm view in the profile directory and reports how the lookup ended', async () => {
  const { dir } = fixture()
  const answer = (value: object) => command.run.mockResolvedValueOnce(value as never)
  answer({ exitCode: 0, stdout: '{"name":"x"}', stderr: '', timedOut: false, isCanceled: false })
  expect(await viewProfilePackage(dir, 'x@^1', { timeoutMs: 5 })).toEqual({ exitCode: 0, stdout: '{"name":"x"}', stderr: '', timedOut: false })
  expect(command.run).toHaveBeenLastCalledWith('pnpm', ['view', 'x@^1', 'name', 'version', 'description', 'dsh', '--json'], expect.objectContaining({
    cwd: dir, timeout: 5, reject: false, stdin: 'ignore',
  }))
  expect((command.run.mock.lastCall as unknown[])[2]).not.toHaveProperty('cancelSignal')
  const signal = AbortSignal.abort()
  answer({ exitCode: undefined, stdout: '', stderr: '', timedOut: true, isCanceled: false })
  expect(await viewProfilePackage(dir, 'x', { timeoutMs: 5, signal })).toEqual({ exitCode: null, stdout: '', stderr: '', timedOut: true })
  expect((command.run.mock.lastCall as unknown[])[2]).toMatchObject({ cancelSignal: signal })
  answer({ exitCode: undefined, stdout: '', stderr: '', timedOut: false, isCanceled: true })
  expect(await viewProfilePackage(dir, 'x', { command: 'node', timeoutMs: 5 })).toEqual({ exitCode: null, stdout: '', stderr: '', timedOut: false })
  expect((command.run.mock.lastCall as unknown[])[0]).toBe('node')
  answer({ exitCode: undefined, stdout: '', stderr: '', timedOut: false, isCanceled: false, code: 'ENOENT', shortMessage: 'spawn pnpm ENOENT' })
  const missing = await viewProfilePackage(dir, 'x', { timeoutMs: 5 })
  expect(missing).toMatchObject({ exitCode: null, timedOut: false })
  expect(missing.cause).toMatchObject({ message: 'spawn pnpm ENOENT', code: 'ENOENT' })
})
