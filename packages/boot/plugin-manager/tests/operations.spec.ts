/** The CLI and manager share package reconciliation, path anchoring and diagnostics. */
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { expect, it, onTestFinished, vi } from 'vitest'
import { getDshRuntimeVersion, initProfile, readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { anchorPathSpec, readProfileRegistry, runPluginCommand, runProfilePnpm, viewProfilePackage } from '../src/operations.ts'

/** What execa resolves for a run that settled, including the buffered output the pre-install lookup is read for. */
interface FakeOutcome {
  exitCode: number | undefined
  failed: boolean
  stdout?: string
  stderr?: string
  code?: string
  shortMessage?: string
}

/** The child execa hands back, including the descriptors an inherited CLI run reports as null. */
interface FakeChild {
  stdout: PassThrough | null
  stderr: PassThrough | null
  nodeChildProcess: EventEmitter
  kill?: () => boolean
}

/** What each kind of pnpm invocation changes in the profile and what it answers. */
interface FakePnpm {
  /** What the run changes in the profile. */
  mutate: (dir: string) => void
  /** The run's exit code and captured output. */
  exitCode: number
  output: string
  /** Exit code of the `install` run that repairs a post-install refusal. */
  repairExit: number
  /** What the pre-install `pnpm view` lookup answers for one spec; `{}` declares no peers. */
  view: (spec: string) => { exitCode: number; stdout: string }
  /** The specs the pre-install check asked `pnpm view` about, in order. */
  views: string[]
}

const command = vi.hoisted(() => ({ run: vi.fn<(...args: unknown[]) => Promise<FakeOutcome> & FakeChild>() }))
vi.mock('execa', () => ({ execa: (...args: unknown[]) => command.run(...args) }))

/** Whether the bounded wait for a recorded run returns at once; the wait itself is measured in run-tree.spec.ts. */
const treeWait = vi.hoisted(() => ({ skip: false }))
vi.mock('../src/run-tree.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/run-tree.ts')>()
  return {
    ...actual,
    awaitTreeGone: async (...args: Parameters<typeof actual.awaitTreeGone>) => {
      if (!treeWait.skip) await actual.awaitTreeGone(...args)
    },
  }
})

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'manager-pnpm-'))
  const dir = join(home, 'profiles', 'test')
  const installAnchor = join(home, 'package.json')
  writeFileSync(installAnchor, '{}\n')
  initProfile(dir, [])
  // One pnpm command per operation: a lookup that only reads the registry, the frozen install that
  // repairs a post-install refusal, and the run itself, which applies the test's mutation and exit code.
  const pnpm: FakePnpm = {
    mutate: () => {},
    exitCode: 0,
    output: '',
    repairExit: 0,
    view: () => ({ exitCode: 0, stdout: '{}' }),
    views: [],
  }
  command.run.mockImplementation((...call: unknown[]) => {
    const argv = call[1] as readonly string[]
    const runDir = (call[2] as { cwd: string }).cwd
    const lookup = argv.indexOf('view')
    if (lookup !== -1) {
      const spec = argv[lookup + 1] as string
      pnpm.views.push(spec)
      const answer = pnpm.view(spec)
      return result(answer.exitCode, answer.stdout)
    }
    if (argv.includes('--frozen-lockfile') || argv.includes('--config.lockfile=false')) return result(pnpm.repairExit, '')
    return result(pnpm.exitCode, pnpm.output, () => { pnpm.mutate(runDir) })
  })
  onTestFinished(() => { command.run.mockReset(); treeWait.skip = false; rmSync(home, { recursive: true, force: true }) })
  return { home, dir, context: { home, profile: 'test', installAnchor, cwd: home }, pnpm }
}

function result(
  exitCode: number | undefined, output: string, mutate: () => void = () => {},
  details: { code?: string; shortMessage?: string } = {},
) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const raw = new EventEmitter()
  const done = Promise.resolve().then(() => {
    mutate()
    stdout.end(output)
    stderr.end()
    return { exitCode, failed: exitCode !== 0, stdout: output, stderr: '', ...details }
  })
  // A launch failure reports on the raw child, which never emits an exit; anything else exits once execa's promise settles.
  // Both arrive on a macrotask, so a fixture built before the run still reaches the listener the run attaches.
  if (details.code === undefined) {
    void done.then(() => { setTimeout(() => { raw.emit('exit', exitCode, null) }, 0) }, () => {})
  } else {
    setTimeout(() => { raw.emit('error', Object.assign(new Error('pnpm failed to launch'), { code: details.code })) }, 0)
  }
  return Object.assign(done, { stdout, stderr, nodeChildProcess: raw })
}

/** A child that printed once and never exits on its own: only the silence bound can end it. */
function silentChild(output: string, exitCode?: number) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const raw = new EventEmitter()
  const exit = Promise.withResolvers<{ exitCode: number | undefined; failed: boolean }>()
  const kill = () => {
    stdout.end()
    stderr.end()
    raw.emit('exit', exitCode ?? null, 'SIGTERM')
    exit.resolve({ exitCode, failed: exitCode !== 0 })
    return true
  }
  stdout.write(output)
  return Object.assign(exit.promise, { stdout, stderr, kill, nodeChildProcess: raw })
}

/** A child that exited while its pipes stay open, as a descendant that inherited them leaves them. */
function heldPipeChild(output: string) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const raw = new EventEmitter()
  const exit = Promise.withResolvers<{ exitCode: number; failed: boolean }>()
  let ended = 0
  // execa settles only once both pipes end, which the bounded drain forces by destroying them.
  for (const stream of [stdout, stderr]) {
    stream.on('close', () => {
      ended += 1
      if (ended === 2) exit.resolve({ exitCode: 0, failed: false })
    })
  }
  // The process exits as soon as the run watches the raw child, so a fixture the
  // test built before the run cannot emit past the listener the run attaches.
  let watched = false
  const watch = (): void => {
    if (watched) return
    watched = true
    setTimeout(() => { raw.emit('exit', 0, null) }, 0)
  }
  const on = raw.on.bind(raw)
  const once = raw.once.bind(raw)
  raw.on = (event, listener) => { const holder = on(event, listener); if (event === 'exit') watch(); return holder }
  raw.once = (event, listener) => { const holder = once(event, listener); if (event === 'exit') watch(); return holder }
  stdout.write(output)
  return Object.assign(exit.promise, { stdout, stderr, nodeChildProcess: raw })
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

function installGuarded(dir: string, dependency: string, name = dependency, version = '1.0.0', peer = '>=999.0.0') {
  install(dir, dependency)
  writeFileSync(join(dir, 'node_modules', dependency, 'package.json'), JSON.stringify({
    name, version, peerDependencies: { '@deepseek-ai/dsh-app-boot': peer }, dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
}

/** A path spec whose manifest declares a peer requirement the running dsh does not satisfy. */
function writePathSpec(home: string, peer: string): void {
  mkdirSync(join(home, 'plugin'), { recursive: true })
  writeFileSync(join(home, 'plugin', 'package.json'), JSON.stringify({
    name: 'plugin', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': peer },
  }))
}

it.each([
  { form: 'a relative path', spec: () => './plugin' },
  { form: 'a file: path', spec: () => 'file:./plugin' },
  { form: 'a link: path', spec: () => 'link:./plugin' },
  { form: 'an absolute path', spec: (home: string) => join(home, 'plugin') },
])('rejects an incompatible $form before pnpm runs and leaves both profile files alone', async ({ spec }) => {
  const { home, dir, context } = fixture()
  writePathSpec(home, '999.0.0')
  const manifestBefore = readFileSync(join(dir, 'package.json'), 'utf8')
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'original-lock\n')
  const messages: string[] = []
  const outcome = await runProfilePnpm(context, ['add', spec(home)], {
    execution: 'service', outputBytes: 8192, onOutput: (text) => { messages.push(text) },
  })
  expect(outcome.exitCode).toBe(1)
  expect(outcome.incompatible).toEqual([
    { name: 'plugin', version: '1.0.0', runtimeVersion: getDshRuntimeVersion(), peers: { '@deepseek-ai/dsh': '999.0.0' } },
  ])
  expect(outcome.output).toContain('installation rejected')
  expect(outcome.output).toContain('plugin@1.0.0')
  expect(outcome.output).toContain('nothing was installed')
  expect(messages.join('')).toContain('nothing was installed')
  expect(readFileSync(outcome.logPath, 'utf8')).toContain('plugin@1.0.0')
  // The spec was read from disk, so no pnpm invocation exists to install anything.
  expect(command.run).not.toHaveBeenCalled()
  expect(existsSync(join(dir, 'node_modules'))).toBe(false)
  expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(manifestBefore)
  expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe('original-lock\n')
})

it.each(['plugin@1.0.0', '@scope/plugin@1.0.0'])('rejects the registry spec %s the pre-install lookup denies, without installing it', async (spec) => {
  const { dir, context, pnpm } = fixture()
  const name = spec.slice(0, spec.lastIndexOf('@'))
  pnpm.view = () => ({
    exitCode: 0,
    stdout: JSON.stringify({ name, version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '999.0.0' } }),
  })
  const manifestBefore = readFileSync(join(dir, 'package.json'), 'utf8')
  const outcome = await runProfilePnpm(context, ['add', spec], { execution: 'service', outputBytes: 8192 })
  expect(outcome).toMatchObject({ exitCode: 1 })
  expect(outcome.output).toContain('installation rejected')
  expect(outcome.output).toContain(`${name}@1.0.0`)
  expect(outcome.output).toContain('nothing was installed')
  // The lookup is the only pnpm invocation: the refused spec never reached an install.
  expect(pnpm.views).toEqual([spec])
  expect(command.run).toHaveBeenCalledTimes(1)
  expect(command.run.mock.calls[0]?.[1] as readonly string[]).toContain('view')
  expect(existsSync(join(dir, 'node_modules'))).toBe(false)
  expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(manifestBefore)
})

it('reads the last match when the registry lookup answers with several versions', async () => {
  const { context, pnpm } = fixture()
  pnpm.view = () => ({
    exitCode: 0,
    stdout: JSON.stringify([
      { name: 'plugin', version: '1.0.0' },
      { name: 'plugin', version: '2.0.0', peerDependencies: { '@deepseek-ai/dsh': '999.0.0' } },
    ]),
  })
  const outcome = await runProfilePnpm(context, ['add', 'plugin@^2', '--registry=https://registry.example'], {
    execution: 'service', outputBytes: 8192, lookupTimeoutMs: 5_000, signal: new AbortController().signal,
  })
  expect(outcome).toMatchObject({ exitCode: 1 })
  expect(outcome.output).toContain('plugin@2.0.0')
  expect(pnpm.views).toEqual(['plugin@^2'])
  // The lookup asks the registry the installation would use.
  expect(command.run.mock.calls[0]?.[1] as readonly string[]).toContain('--registry=https://registry.example')
  expect(command.run).toHaveBeenCalledTimes(1)
})

it('runs an invocation that names no command without a registry lookup', async () => {
  const { context, pnpm } = fixture()
  expect(await runProfilePnpm(context, ['--version'], { execution: 'service', outputBytes: 8192 }))
    .toMatchObject({ exitCode: 0 })
  expect(pnpm.views).toEqual([])
})

it('installs an incompatible path spec the profile exempts', async () => {
  const { home, dir, context, pnpm } = fixture()
  writePathSpec(home, '999.0.0')
  writeFileSync(join(dir, 'compatibility.json'), JSON.stringify({ 'plugin@1.0.0': [getDshRuntimeVersion()] }) + '\n')
  pnpm.mutate = (target) => {
    install(target, 'plugin')
    writeFileSync(join(target, 'node_modules', 'plugin', 'package.json'), JSON.stringify({
      name: 'plugin', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '999.0.0' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
  }
  expect(await runProfilePnpm(context, ['add', './plugin'], { execution: 'service', outputBytes: 8192 }))
    .toMatchObject({ exitCode: 0 })
  // A path spec never needs a registry lookup, and the exemption covers the installed manifest too.
  expect(pnpm.views).toEqual([])
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['plugin'])
})

it('installs a compatible path spec', async () => {
  const { home, dir, context, pnpm } = fixture()
  writePathSpec(home, '*')
  pnpm.mutate = (target) => { install(target, 'plugin') }
  expect(await runProfilePnpm(context, ['add', './plugin'], { execution: 'service', outputBytes: 8192 }))
    .toMatchObject({ exitCode: 0 })
  expect(pnpm.views).toEqual([])
  expect(command.run).toHaveBeenCalledTimes(1)
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['plugin'])
})

it('runs the install with the caller\'s flags and its path specs anchored', async () => {
  const { context, pnpm } = fixture()
  pnpm.mutate = (target) => { install(target, 'extra') }
  expect(await runProfilePnpm(context, ['add', './extra', '--ignore-scripts'], {
    execution: 'service', outputBytes: 8192, activateNewBundles: false,
  })).toMatchObject({ exitCode: 0 })
  expect(command.run.mock.calls[0]?.[1]).toEqual(['add', join(context.cwd, 'extra'), '--ignore-scripts'])
})

it.each([
  { answer: 'a failing lookup', view: { exitCode: 1, stdout: '' } },
  { answer: 'an unparsable answer', view: { exitCode: 0, stdout: 'ERR_PNPM_UNEXPECTED' } },
])('continues to the install after $answer', async ({ view }) => {
  const { dir, context, pnpm } = fixture()
  pnpm.view = () => view
  pnpm.mutate = (target) => { install(target, 'plugin') }
  expect(await runProfilePnpm(context, ['add', 'plugin'], { execution: 'service', outputBytes: 8192 }))
    .toMatchObject({ exitCode: 0 })
  // The lookup could not judge the spec, so the run itself is what installs and checks it.
  expect(pnpm.views).toEqual(['plugin'])
  expect(command.run).toHaveBeenCalledTimes(2)
  expect(command.run.mock.lastCall?.[1]).toEqual(['add', 'plugin'])
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['plugin'])
})

it.each(['github:owner/repo', 'https://example.com/plugin.tgz'])(
  'reaches the install for %s without asking the registry', async (spec) => {
    const { context, pnpm } = fixture()
    expect(await runProfilePnpm(context, ['add', spec], { execution: 'service', outputBytes: 8192 }))
      .toMatchObject({ exitCode: 0 })
    expect(pnpm.views).toEqual([])
    expect(command.run).toHaveBeenCalledTimes(1)
    expect(command.run.mock.calls[0]?.[1]).toEqual(['add', spec])
  })

it('makes no registry lookup for commands that are not installs', async () => {
  const { context, pnpm } = fixture()
  for (const args of [['update'], ['remove', 'plugin'], ['list'], ['approve-builds']]) {
    expect(await runProfilePnpm(context, args, { execution: 'service', outputBytes: 8192 }))
      .toMatchObject({ exitCode: 0 })
  }
  expect(pnpm.views).toEqual([])
  expect(command.run).toHaveBeenCalledTimes(4)
})

it.each([true, false])('rejects incompatible installed manifests before activation (%s) and restores exact profile files', async (activateNewBundles) => {
  const { dir, context, pnpm } = fixture()
  const manifestBefore = readFileSync(join(dir, 'package.json'), 'utf8')
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'original-lock\n')
  const messages: string[] = []
  // Only the installed manifest carries the incompatibility, so it is the post-install check that refuses it.
  pnpm.mutate = (target) => {
    installGuarded(target, 'incompatible')
    writeFileSync(join(target, 'pnpm-lock.yaml'), 'changed-lock\n')
  }
  const outcome = await runProfilePnpm(context, ['add', 'incompatible'], {
    execution: 'service', outputBytes: 8192, activateNewBundles, onOutput: (text) => { messages.push(text) },
  })
  expect(outcome.exitCode).toBe(1)
  expect(outcome.incompatible).toMatchObject([{ name: 'incompatible', version: '1.0.0', peers: { '@deepseek-ai/dsh-app-boot': '>=999.0.0' } }])
  expect(outcome.output).toContain('incompatible@1.0.0')
  expect(outcome.output).toContain('installation rejected')
  expect(readFileSync(outcome.logPath, 'utf8')).toContain('incompatible@1.0.0')
  expect(messages.join('')).toContain('installation rejected')
  expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(manifestBefore)
  expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe('original-lock\n')
  // The refused run replaced the installed tree, so the restored lockfile is reinstalled.
  expect(command.run).toHaveBeenLastCalledWith(expect.anything(), ['install', '--frozen-lockfile'], expect.anything())
  expect(outcome.output).toContain('and node_modules')
})

it('repairs a profile that had no lockfile without creating one', async () => {
  const { dir, context, pnpm } = fixture()
  pnpm.mutate = (target) => {
    installGuarded(target, 'incompatible')
    writeFileSync(join(target, 'pnpm-lock.yaml'), 'created-lock\n')
  }
  const outcome = await runProfilePnpm(context, ['add', 'incompatible'], { execution: 'service', outputBytes: 8192 })
  expect(outcome.exitCode).toBe(1)
  expect(existsSync(join(dir, 'pnpm-lock.yaml'))).toBe(false)
  expect(command.run).toHaveBeenLastCalledWith(expect.anything(), ['install', '--config.lockfile=false'], expect.anything())
  expect(outcome.output).toContain('and node_modules')
})

it('reports an unrepaired node_modules when the restoring install fails', async () => {
  const { context, pnpm } = fixture()
  pnpm.mutate = (target) => { installGuarded(target, 'incompatible') }
  pnpm.repairExit = 1
  const outcome = await runProfilePnpm(context, ['add', 'incompatible'], {
    execution: 'service', outputBytes: 8192, idleTimeoutMs: 5_000,
  })
  expect(outcome).toMatchObject({ exitCode: 1 })
  expect(outcome.output).toContain('node_modules could not be reinstalled')
  expect(outcome.output).toContain("run 'dsh plugin install'")
})

it('detects a version update that keeps the dependency spec and removes a lockfile the run created', async () => {
  const { dir, context, pnpm } = fixture()
  // The installed tree holds an accepted generation of the dependency the profile already selects.
  installGuarded(dir, 'updated', 'updated', '1.0.0', '*')
  const before = readFileSync(join(dir, 'package.json'), 'utf8')
  // `pnpm update` keeps the manifest spec and replaces only the installed contents.
  pnpm.mutate = (target) => {
    writeFileSync(join(target, 'node_modules', 'updated', 'package.json'), JSON.stringify({
      name: 'updated', version: '2.0.0', peerDependencies: { '@deepseek-ai/dsh-app-boot': '>=999.0.0' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    writeFileSync(join(target, 'pnpm-lock.yaml'), 'changed-lock\n')
  }
  const outcome = await runProfilePnpm(context, ['update'], { execution: 'service', outputBytes: 8192 })
  expect(outcome).toMatchObject({ exitCode: 1 })
  expect(outcome.output).toContain('updated@2.0.0')
  expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
  // The run created the lockfile, so the refusal removes it instead of restoring one.
  expect(existsSync(join(dir, 'pnpm-lock.yaml'))).toBe(false)
})

it('does not fail an unrelated installation on an untouched incompatible dependency', async () => {
  const { context, dir, pnpm } = fixture()
  installGuarded(dir, 'incompatible')
  const messages: string[] = []
  pnpm.mutate = (target) => { install(target, 'unrelated') }
  expect(await runProfilePnpm(context, ['add', 'unrelated'], {
    execution: 'service', outputBytes: 8192, onOutput: (text) => { messages.push(text) },
  })).toMatchObject({ exitCode: 0 })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['unrelated'])
  expect(messages.join('')).toContain('startup denies it')
})

it('installs a dependency whose installed manifest declares compatible peers', async () => {
  const { dir, context, pnpm } = fixture()
  pnpm.mutate = (target) => {
    install(target, 'plugin')
    writeFileSync(join(target, 'node_modules', 'plugin', 'package.json'), JSON.stringify({
      name: 'plugin', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '*' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
  }
  expect(await runProfilePnpm(context, ['add', 'plugin'], { execution: 'service', outputBytes: 8192 }))
    .toMatchObject({ exitCode: 0 })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['plugin'])
})

it.each([
  { key: 'actual@1.0.0', runtime: 'current', exitCode: 0 },
  { key: 'alias@1.0.0', runtime: 'current', exitCode: 1 },
  { key: 'actual@2.0.0', runtime: 'current', exitCode: 1 },
  { key: 'actual@1.0.0', runtime: '999.0.0', exitCode: 1 },
])('matches exemptions to the actual alias manifest and exact versions: $key / $runtime', async ({ key, runtime, exitCode }) => {
  const { dir, context, pnpm } = fixture()
  writeFileSync(join(dir, 'compatibility.json'), JSON.stringify({ [key]: [runtime === 'current' ? getDshRuntimeVersion() : runtime] }) + '\n')
  pnpm.mutate = (target) => { installGuarded(target, 'alias', 'actual') }
  expect(await runProfilePnpm(context, ['add', 'alias@npm:actual@1.0.0'], { execution: 'service', outputBytes: 8192 })).toMatchObject({ exitCode })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(exitCode === 0 ? ['alias'] : [])
})

it.each(['list', 'remove'])('allows %s with preexisting incompatible packages', async (operation) => {
  const { dir, context, pnpm } = fixture()
  installGuarded(dir, 'incompatible')
  // An inventory command changes nothing; `remove` deletes the row the run reports it deleted.
  if (operation === 'remove') {
    pnpm.mutate = (target) => {
      const manifest = readProfileManifest('test', target)
      delete manifest.dependencies?.incompatible
      writeFileSync(join(target, 'package.json'), JSON.stringify(manifest))
    }
  }
  expect(await runProfilePnpm(context, [operation, 'incompatible'], { execution: 'service', outputBytes: 8192 })).toMatchObject({ exitCode: 0 })
})

it.each(['devDependencies', 'optionalDependencies'])('checks installed direct plugins in %s', async (field) => {
  const { context, pnpm } = fixture()
  pnpm.mutate = (target) => {
    installGuarded(target, 'incompatible')
    const manifest = readProfileManifest('test', target)
    writeFileSync(join(target, 'package.json'), JSON.stringify({ ...manifest, dependencies: {}, [field]: { incompatible: '1' } }))
  }
  expect(await runProfilePnpm(context, ['install'], { execution: 'service', outputBytes: 8192 })).toMatchObject({ exitCode: 1 })
})

it('rejects an incompatible component declared by a newly installed bundle', async () => {
  const { dir, context, pnpm } = fixture()
  pnpm.mutate = (target) => {
    install(target, 'bundle')
    const packageDir = join(target, 'node_modules', 'bundle')
    const component = join(packageDir, 'node_modules', 'component')
    mkdirSync(component, { recursive: true })
    writeFileSync(join(component, 'package.json'), JSON.stringify({
      name: 'component', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '>=999.0.0' },
    }))
    writeFileSync(join(packageDir, 'cordis.patch.yml'), '- insert:\n    - id: component\n      name: component/subpath\n')
  }
  const outcome = await runProfilePnpm(context, ['add', 'bundle'], { execution: 'service', outputBytes: 8192, activateNewBundles: false })
  expect(outcome.exitCode).toBe(1)
  expect(outcome.output).toContain('component@1.0.0')
  expect(readProfileManifest('test', dir).dependencies).toEqual({})
})

it('restores the manifest on malformed installed peer metadata and bounds the warning', async () => {
  const { dir, context, pnpm } = fixture()
  const before = readFileSync(join(dir, 'package.json'), 'utf8')
  pnpm.mutate = (target) => {
    install(target, 'malformed')
    writeFileSync(join(target, 'node_modules', 'malformed', 'package.json'), JSON.stringify({ name: 'malformed', version: '1.0.0', peerDependencies: [] }))
  }
  const outcome = await runProfilePnpm(context, ['add', 'malformed'], { execution: 'service', outputBytes: 4 })
  expect(outcome).toMatchObject({ exitCode: 1, truncated: true })
  expect(Buffer.byteLength(outcome.output)).toBe(4)
  expect(readFileSync(outcome.logPath, 'utf8')).toContain('Cannot validate installed package malformed')
  expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
})

it('checks scoped components in nested groups while leaving unresolved and local rows to startup', async () => {
  const { context, pnpm } = fixture()
  pnpm.mutate = (target) => {
    install(target, 'bundle')
    const packageDir = join(target, 'node_modules', 'bundle')
    const component = join(packageDir, 'node_modules', '@example', 'component')
    mkdirSync(component, { recursive: true })
    writeFileSync(join(component, 'package.json'), JSON.stringify({ name: '@example/component', version: '1.0.0' }))
    writeFileSync(join(packageDir, 'cordis.patch.yml'), JSON.stringify([{ insert: [
      { id: 'group', group: true, config: [{ id: 'component', name: '@example/component/subpath' }] },
      { id: 'empty-group', group: true, config: {} },
      { id: 'relative', name: './plugin.mjs' },
      { id: 'absolute', name: '/plugin.mjs' },
      { id: 'url', name: 'file:///plugin.mjs' },
      { id: 'unresolved', name: 'uninstalled-plugin' },
    ] }]))
  }
  expect(await runProfilePnpm(context, ['add', 'bundle'], { execution: 'service', outputBytes: 8192 })).toMatchObject({ exitCode: 0 })
})

it('reports unreadable snapshot files before invoking pnpm', async () => {
  const { dir, context } = fixture()
  mkdirSync(join(dir, 'pnpm-lock.yaml'))
  await expect(runProfilePnpm(context, ['install'], { execution: 'service', outputBytes: 100 })).rejects.toThrow()
  expect(command.run).not.toHaveBeenCalled()
})

it('anchors relative package specs without rewriting registry specs', () => {
  expect(anchorPathSpec('.', '/workspace')).toBe(resolve('/workspace'))
  expect(anchorPathSpec('file:../plugin', '/workspace/project')).toBe(`file:${resolve('/workspace/plugin')}`)
  expect(anchorPathSpec('package@1', '/workspace')).toBe('package@1')
})

it('activates newly installed bundles and leaves retained disabled dependencies disabled', async () => {
  const { dir, context, pnpm } = fixture()
  install(dir, 'disabled')
  pnpm.mutate = (target) => { install(target, 'new-bundle') }
  expect(await runPluginCommand(context, ['add', 'new-bundle'], { execution: 'service', outputBytes: 100 })).toMatchObject({ exitCode: 0 })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['new-bundle'])
  pnpm.mutate = () => {}
  await runPluginCommand(context, ['update'], { execution: 'service', outputBytes: 100 })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['new-bundle'])
})

it('can install without activation and bounds output while retaining the complete log', async () => {
  const { dir, context, pnpm } = fixture()
  pnpm.mutate = (target) => { install(target, 'extra') }
  pnpm.output = '0123456789'
  const outcome = await runProfilePnpm(context, ['add', './extra'], { execution: 'service', outputBytes: 4, activateNewBundles: false })
  expect(outcome).toMatchObject({ exitCode: 0, output: '6789', truncated: true })
  expect(readFileSync(outcome.logPath, 'utf8')).toBe('0123456789')
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual([])
  expect(command.run.mock.calls[0]?.[1]).toEqual(['add', join(context.cwd, 'extra')])
})

it.each([runPluginCommand, runProfilePnpm])('installs into the supplied application profile directory with %s', async (run) => {
  const { home, dir: namedDir, context, pnpm } = fixture()
  const dir = join(home, 'application', 'profile')
  initProfile(dir, [])
  pnpm.mutate = (target) => { install(target, 'extra') }
  const outcome = await run({ ...context, dir }, ['add', 'extra'], { execution: 'service', outputBytes: 100 })
  expect(outcome.exitCode).toBe(0)
  expect(command.run).toHaveBeenCalledWith(expect.anything(), ['add', 'extra'], expect.objectContaining({ cwd: dir }))
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['extra'])
  expect(readProfileManifest('test', namedDir).dependencies).not.toHaveProperty('extra')
  expect(readProfileManifest('test', namedDir).dsh?.profile?.bundles).toEqual([])
})

it('retains partial package-manager changes after a failed install without activating them', async () => {
  const { dir, context, pnpm } = fixture()
  pnpm.mutate = (target) => { install(target, 'partial') }
  pnpm.exitCode = 1
  expect(await runProfilePnpm(context, ['add', 'partial'], { execution: 'service', outputBytes: 100 })).toMatchObject({ exitCode: 1 })
  expect(readProfileManifest('test', dir).dependencies).toEqual({ partial: '1' })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual([])
})


it('initializes missing profiles under the same lock and reports initialization', async () => {
  const { home, context } = fixture()
  const messages: string[] = []
  for (const profile of ['custom', 'web']) {
    await runPluginCommand({ ...context, profile }, ['root'], {
      execution: 'service', outputBytes: 100, lockWaitMs: 1000, onOutput: (text) => { messages.push(text) },
    })
    expect(readProfileManifest('test', join(home, 'profiles', profile)).dsh?.profile?.bundles).toContain('@deepseek-ai/dsh-base')
  }
  expect(messages.filter(text => text.includes('initialized profile'))).toHaveLength(2)
})

/** The record an operation leaves for the pnpm run it started. */
function runRecord(dir: string): string {
  return join(dir, '.plugin-manager', 'run.json')
}

/** A run that exits after `ms`, reading the profile's run record while it is still running. */
function observingChild(dir: string, pid: number, ms = 100) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const raw = new EventEmitter()
  const observed: { record: string | undefined } = { record: undefined }
  const done = new Promise<FakeOutcome>((resolve) => {
    setTimeout(() => {
      observed.record = existsSync(runRecord(dir)) ? readFileSync(runRecord(dir), 'utf8') : undefined
      stdout.end()
      stderr.end()
      raw.emit('exit', 0, null)
      resolve({ exitCode: 0, failed: false, stdout: '', stderr: '' })
    }, ms)
  })
  return { child: Object.assign(done, { stdout, stderr, nodeChildProcess: raw, pid }), observed }
}

it.each([8192, 30])('refuses to run while a run recorded by an exited operation is still active (output bound %i)', async (outputBytes) => {
  const { dir, context } = fixture()
  treeWait.skip = true
  mkdirSync(join(dir, '.plugin-manager'), { recursive: true })
  const record = JSON.stringify({ pid: process.pid, grouped: false })
  writeFileSync(runRecord(dir), record)
  const messages: string[] = []
  const outcome = await runProfilePnpm(context, ['add', './extra'], {
    execution: 'service', outputBytes, onOutput: (text) => { messages.push(text) },
  })
  const diagnostic = readFileSync(outcome.logPath, 'utf8')
  expect(diagnostic).toContain(`process ${String(process.pid)}, started by an earlier package operation whose own process ended, is still running`)
  expect(diagnostic).toContain(`delete ${runRecord(dir)}`)
  expect(messages.join('')).toBe(diagnostic)
  expect(outcome).toMatchObject({ exitCode: 1, truncated: diagnostic.length > outputBytes })
  expect(outcome.output).toBe(diagnostic.slice(-outputBytes))
  expect(command.run).not.toHaveBeenCalled()
  expect(readFileSync(runRecord(dir), 'utf8')).toBe(record)
})

it('removes the record of a recorded run that stopped and runs', async () => {
  const { dir, context } = fixture()
  const exited = 2_000_000_000
  const kill = process.kill.bind(process)
  vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
    if (target === exited) throw Object.assign(new Error('ESRCH: injected'), { code: 'ESRCH' })
    return kill(target, signal)
  })
  onTestFinished(() => { vi.restoreAllMocks() })
  mkdirSync(join(dir, '.plugin-manager'), { recursive: true })
  writeFileSync(runRecord(dir), JSON.stringify({ pid: exited, grouped: false }))
  const outcome = await runProfilePnpm(context, ['add', './extra'], { execution: 'service', outputBytes: 8192 })
  expect(outcome.exitCode).toBe(0)
  expect(command.run).toHaveBeenCalledOnce()
  expect(existsSync(runRecord(dir))).toBe(false)
})

it.each(['not json', 'null', '{"pid":0,"grouped":false}', '{"pid":12,"grouped":"no"}'])(
  'refuses to run beside a run record that names no run: %s', async (record) => {
    const { dir, context } = fixture()
    mkdirSync(join(dir, '.plugin-manager'), { recursive: true })
    writeFileSync(runRecord(dir), record)
    const outcome = await runProfilePnpm(context, ['add', './extra'], { execution: 'service', outputBytes: 8192 })
    expect(outcome).toMatchObject({ exitCode: 1 })
    expect(outcome.output).toBe(`dsh: ${runRecord(dir)} does not name a package run; delete it once no earlier package operation is still running in this profile\n`)
    expect(command.run).not.toHaveBeenCalled()
  },
)

it.each(['cli', 'service'] as const)('records a %s run while it runs and removes the record once it ends', async (execution) => {
  const { dir, context } = fixture()
  const { child, observed } = observingChild(dir, 4242)
  command.run.mockImplementationOnce(() => child)
  const outcome = await runProfilePnpm(context, ['list'], { execution, outputBytes: 8192 })
  expect(outcome.exitCode).toBe(0)
  expect(JSON.parse(observed.record ?? 'null')).toEqual({
    pid: 4242, grouped: execution === 'service' && process.platform !== 'win32',
  })
  expect(existsSync(runRecord(dir))).toBe(false)
})

it('records the install that repairs a refused installation', async () => {
  const { dir, context, pnpm } = fixture()
  pnpm.mutate = (target) => { installGuarded(target, 'incompatible') }
  const base = command.run.getMockImplementation() as (...call: unknown[]) => Promise<FakeOutcome> & FakeChild
  const repair = observingChild(dir, 4343)
  command.run.mockImplementation((...call: unknown[]) => {
    return (call[1] as readonly string[]).includes('--config.lockfile=false') ? repair.child : base(...call)
  })
  const outcome = await runProfilePnpm(context, ['add', 'incompatible'], { execution: 'service', outputBytes: 8192 })
  expect(outcome.exitCode).toBe(1)
  expect(JSON.parse(repair.observed.record ?? 'null')).toEqual({ pid: 4343, grouped: false })
  expect(existsSync(runRecord(dir))).toBe(false)
})

it('terminates a run that stopped printing and reports the silence bound', async () => {
  const { context } = fixture()
  command.run.mockImplementationOnce(() => silentChild('installing\n'))
  const outcome = await runProfilePnpm(context, ['add', './extra'], { execution: 'service', outputBytes: 100, idleTimeoutMs: 20 })
  expect(outcome).toMatchObject({ exitCode: 1, timedOut: true })
  expect(outcome.output).toBe('installing\ndsh: pnpm printed nothing for 20ms and was terminated\n')
  expect(readFileSync(outcome.logPath, 'utf8')).toBe(outcome.output)
})

it('settles a run whose pipes stay open past the process exit', async () => {
  const { context } = fixture()
  const child = heldPipeChild('installed\n')
  command.run.mockImplementationOnce(() => child)
  const outcome = await runProfilePnpm(context, ['add', './extra'], {
    execution: 'service', outputBytes: 100, activateNewBundles: false,
  })
  expect(outcome).toMatchObject({ exitCode: 0 })
  expect(outcome.output).toBe('installed\ndsh: pnpm output was cut short after its process exited\n')
  // The pipes never ended on their own, so the run settled by cutting them here.
  expect(child.stdout.destroyed).toBe(true)
  expect(child.stderr.destroyed).toBe(true)
  expect(outcome.timedOut).toBeUndefined()
})

it('reports a terminated run that trapped the signal and exited zero', async () => {
  const { context } = fixture()
  command.run.mockImplementationOnce(() => silentChild('installing\n', 0))
  const outcome = await runProfilePnpm(context, ['add', './extra'], { execution: 'service', outputBytes: 100, idleTimeoutMs: 20 })
  // The independent facts stay separate: the signal was trapped, so the exit status is still zero.
  expect(outcome).toMatchObject({ exitCode: 0, timedOut: true })
  expect(outcome.output).toContain('printed nothing for 20ms and was terminated')
})

it('surfaces an output consumer failure the bounded drain cuts short', async () => {
  const { context } = fixture()
  command.run.mockImplementationOnce(() => heldPipeChild('installed\n'))
  await expect(runProfilePnpm(context, ['add', './extra'], {
    execution: 'service', outputBytes: 100, activateNewBundles: false,
    onOutput() { throw new Error('output destination closed') },
  })).rejects.toThrow('output destination closed')
})

it('reports a reading that fails with something other than an Error by its text', async () => {
  const { context } = fixture()
  const child = heldPipeChild('installed\n')
  command.run.mockImplementationOnce(() => child)
  await expect(runProfilePnpm(context, ['add', './extra'], {
    execution: 'service', outputBytes: 100, activateNewBundles: false,
    // A reading can reject with any value; its text is what the failure reports.
    onOutput() { throw 'pipe broke' },
  })).rejects.toThrow('pipe broke')
})

it('terminates a service run as a tree and leaves the CLI in the caller group', async () => {
  const { context } = fixture()
  await runProfilePnpm(context, ['add', 'tree'], { execution: 'service', outputBytes: 100, activateNewBundles: false })
  await runProfilePnpm(context, ['add', 'tree'], { execution: 'cli', outputBytes: 100, activateNewBundles: false })
  expect(command.run).toHaveBeenCalledWith(
    expect.anything(), expect.anything(), expect.objectContaining({ killDescendants: true }),
  )
  expect(command.run).toHaveBeenLastCalledWith(
    expect.anything(), expect.anything(), expect.objectContaining({ killDescendants: false }),
  )
})

it('retains built-in layers, removes deleted dependencies and warns about plain packages', async () => {
  const { context, dir, pnpm } = fixture()
  install(dir, 'removed')
  const manifest = readProfileManifest('test', dir)
  manifest.dsh = { profile: { bundles: ['builtin', 'removed'] } }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  const messages: string[] = []
  pnpm.mutate = (target) => {
    install(target, 'plain')
    writeFileSync(join(target, 'node_modules', 'plain', 'package.json'), '{"name":"plain"}')
    const after = readProfileManifest('test', target)
    delete after.dependencies?.removed
    writeFileSync(join(target, 'package.json'), JSON.stringify(after))
  }
  await runPluginCommand(context, ['remove', 'removed'], { execution: 'service', outputBytes: 100, onOutput: (text) => { messages.push(text) } })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['builtin'])
  expect(messages.join('')).toContain('plain dependency')
})

it('preserves a package-manager selected new bundle without adding it twice', async () => {
  const { context, dir, pnpm } = fixture()
  writeFileSync(join(dir, 'package.json'), '{}')
  pnpm.mutate = (target) => {
    install(target, 'new')
    const manifest = readProfileManifest('test', target)
    manifest.dsh = { profile: { bundles: ['new'] } }
    writeFileSync(join(target, 'package.json'), JSON.stringify(manifest))
  }
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
  await expect(runProfilePnpm(context, ['add', './extra'], {
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
  command.run.mockImplementationOnce(() => Object.assign(Promise.reject(new Error('subprocess failed')), {
    stdout, stderr, nodeChildProcess: new EventEmitter(),
  }))
  await expect(runProfilePnpm(context, ['root'], { execution: 'service', outputBytes: 100 })).rejects.toThrow('subprocess failed')
})


it('allows inventory commands when a declared dependency is missing from disk', async () => {
  const { context, dir } = fixture()
  install(dir, 'missing')
  rmSync(join(dir, 'node_modules', 'missing'), { recursive: true })
  command.run.mockImplementationOnce(() => result(0, 'missing dependency'))
  expect(await runProfilePnpm(context, ['list'], { execution: 'service', outputBytes: 100, activateNewBundles: false }))
    .toMatchObject({ exitCode: 0 })
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
    Promise.resolve({ exitCode: 0, failed: false }), { stdout: null, stderr: null, nodeChildProcess: new EventEmitter() },
  ))
  expect(await runPluginCommand(context, ['approve-builds'], { execution: 'cli', outputBytes: 100 })).toMatchObject({ exitCode: 0, output: '' })
})

it('reads the registry pnpm\'s own configuration names in the profile, and answers null for anything but a URL', async () => {
  const { dir } = fixture()
  const answer = (value: object) => command.run.mockResolvedValueOnce(value as never)
  answer({ exitCode: 0, stdout: 'https://registry.npmmirror.com/\n', stderr: '' })
  expect(await readProfileRegistry(dir, { timeoutMs: 5 })).toBe('https://registry.npmmirror.com/')
  expect(command.run).toHaveBeenLastCalledWith('pnpm', ['config', 'get', 'registry'], expect.objectContaining({ cwd: dir, timeout: 5, reject: false, stdin: 'ignore' }))
  // Output pnpm prefixes with a notice keeps its last line; a failed or empty answer, or one that is no URL, reads as unknown.
  answer({ exitCode: 0, stdout: 'WARN  something\nhttps://npm.corp.example/', stderr: '' })
  expect(await readProfileRegistry(dir, { command: '/app/pnpm', args: ['--x'], timeoutMs: 5 })).toBe('https://npm.corp.example/')
  expect((command.run.mock.lastCall as unknown[]).slice(0, 2)).toEqual(['/app/pnpm', ['--x', 'config', 'get', 'registry']])
  answer({ exitCode: 1, stdout: '', stderr: 'ERR' })
  expect(await readProfileRegistry(dir, { timeoutMs: 5 })).toBeNull()
  answer({ exitCode: 0, stdout: 'undefined\n', stderr: '' })
  expect(await readProfileRegistry(dir, { timeoutMs: 5 })).toBeNull()
  answer({ exitCode: 0, stdout: '', stderr: '' })
  expect(await readProfileRegistry(dir, { timeoutMs: 5 })).toBeNull()
})

it('asks the registry through pnpm view in the profile directory, without pnpm\'s own retries, and reports how the lookup ended', async () => {
  const { dir } = fixture()
  const answer = (value: object) => command.run.mockResolvedValueOnce(value as never)
  answer({ exitCode: 0, stdout: '{"name":"x"}', stderr: '', timedOut: false, isCanceled: false })
  expect(await viewProfilePackage(dir, 'x@^1', { timeoutMs: 5 })).toEqual({ exitCode: 0, stdout: '{"name":"x"}', stderr: '', timedOut: false })
  expect(command.run).toHaveBeenLastCalledWith('pnpm', ['view', 'x@^1', 'name', 'version', 'description', 'dsh', '--json', '--config.fetch-retries=0'],
    expect.objectContaining({ cwd: dir, timeout: 5, reject: false, stdin: 'ignore' }))
  expect((command.run.mock.lastCall as unknown[])[2]).not.toHaveProperty('cancelSignal')
  // A registry asked by URL goes on the command line; null leaves the choice to pnpm's own configuration.
  answer({ exitCode: 0, stdout: '{"name":"x"}', stderr: '', timedOut: false, isCanceled: false })
  await viewProfilePackage(dir, 'x', { timeoutMs: 5, registry: 'https://registry.npmmirror.com/' })
  expect((command.run.mock.lastCall as unknown[])[1]).toEqual(['view', 'x', 'name', 'version', 'description', 'dsh', '--json', '--registry=https://registry.npmmirror.com/', '--config.fetch-retries=0'])
  answer({ exitCode: 0, stdout: '{"name":"x"}', stderr: '', timedOut: false, isCanceled: false })
  await viewProfilePackage(dir, 'x', { timeoutMs: 5, registry: null })
  expect((command.run.mock.lastCall as unknown[])[1]).toEqual(['view', 'x', 'name', 'version', 'description', 'dsh', '--json', '--config.fetch-retries=0'])
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

it('uses application-owned executable arguments and environment for package operations and inspection', async () => {
  const { dir, context } = fixture()
  const runtime = { command: '/app/electron', args: ['--expose-internals', '/app/pnpm.mjs'], env: { ELECTRON_RUN_AS_NODE: '1', PATH: '/app/bin' } }
  await runProfilePnpm(context, ['add', './extra'], { ...runtime, execution: 'service', outputBytes: 100, activateNewBundles: false })
  expect(command.run.mock.calls[0]).toEqual([runtime.command, [...runtime.args, 'add', resolve(context.cwd, 'extra')],
    expect.objectContaining({ env: expect.objectContaining(runtime.env) as unknown })])
  command.run.mockResolvedValueOnce(Object.assign({ exitCode: 0, failed: false }, { stdout: '{}', stderr: '', timedOut: false }))
  await viewProfilePackage(dir, 'example', { ...runtime, timeoutMs: 1000 })
  expect(command.run).toHaveBeenLastCalledWith(runtime.command,
    [...runtime.args, 'view', 'example', 'name', 'version', 'description', 'dsh', '--json', '--config.fetch-retries=0'],
    expect.objectContaining({ env: expect.objectContaining(runtime.env) as unknown }))
})
