import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { format } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import EnvironmentRegistry, { type EnvironmentHandle } from '@deepseek-ai/dsh-environment'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import * as SshEnvironment from '@deepseek-ai/dsh-environment-ssh'
import * as Bootstrap from '@deepseek-ai/dsh-environment-ssh/src/bootstrap.ts'
import * as SshConfigEnvironment from '../src/index.ts'
import { DirectoryWatch } from '../src/watch.ts'

const watching = vi.hoisted(() => ({ refusal: undefined as Error | undefined }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    watch: (...args: Parameters<typeof actual.watch>) => {
      if (watching.refusal !== undefined) throw watching.refusal
      return actual.watch(...args)
    },
  }
})

let ctx: Context | undefined
let directory: string | undefined
afterEach(async () => {
  watching.refusal = undefined
  // Restore spies first: a spy on a fake timer function would otherwise reinstall it.
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await ctx?.fiber.dispose()
  ctx = undefined
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

async function boot(): Promise<{ ctx: Context; file: string; directory: string }> {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-ssh-config-')))
  const file = join(directory, 'ssh_config')
  await writeFile(file, 'Host build test\n  HostName box.example\nHost *\n  User nobody\n')
  const config = join(directory, 'cordis.yml')
  await writeFile(config, [
    '- name: cordis:registry', '- name: cordis:subprocess', '- name: cordis:sandbox',
    '- name: cordis:policy', '  config:', '    mode: danger-full-access',
  ].join('\n') + '\n')
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  Object.assign(ctx.loader.builtins, {
    registry: EnvironmentRegistry, subprocess: LocalSubprocess, sandbox: LocalSandbox,
    policy: SandboxPolicy, discovery: SshConfigEnvironment,
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  return { ctx, file, directory }
}

const shared = { daemonPath: '/configured/daemon.js', ssh: ['/nonexistent/configured-ssh'] }

/** Run an empty function once in a registered environment. */
const ping = (ctx: Context, handle: EnvironmentHandle): Promise<null> =>
  ctx.environments.define(() => null, { result: z.null() })(handle, null, { signal: new AbortController().signal })

async function contribute(ctx: Context, config: Record<string, unknown>): Promise<string> {
  const id = await ctx.loader.create({ name: 'cordis:discovery', config })
  await ctx.loader.await()
  await ctx.loader.resolve(id).fiber!.await()
  return id
}

/** Remove a Loader entry as hot reloading does, and wait until its fiber has unloaded. */
async function remove(ctx: Context, id: string): Promise<void> {
  const fiber = ctx.loader.resolve(id).fiber!
  ctx.loader.remove(id)
  await fiber.await()
}

const handles = (ctx: Context): string[] => ctx.environments.list().map(({ handle }) => handle)

/** Resolve once the registry lists exactly `expected`, checking now and after every registry change. */
function listed(ctx: Context, expected: readonly string[]): Promise<undefined> {
  const { promise, resolve } = Promise.withResolvers<undefined>()
  const check = (): void => {
    if (JSON.stringify(handles(ctx)) !== JSON.stringify(expected)) return
    stop()
    resolve(undefined)
  }
  const stop = ctx.on('environments/change', check)
  check()
  return promise
}

/** Resolve with the first warning whose formatted text matches `pattern`. */
function warned(ctx: Context, pattern: RegExp): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>()
  const stop = ctx.logger.exporter({
    export: (message) => {
      const args: unknown[] = message.args
      const text = format(...args)
      if (message.type !== 'warn' || !pattern.test(text)) return
      void stop()
      resolve(text)
    },
  })
  return promise
}

/** Resolve once `condition` holds, polling in real time, also under fake timers. */
async function poll(condition: () => boolean): Promise<void> {
  while (!condition()) await sleep(5)
}

/**
 * Repeat `act` every 100 ms until `observed` settles. A watcher that macOS has just started can miss a change; repeating
 * an action that leaves discovery's result unchanged produces another change to report.
 */
async function repeat(act: () => Promise<unknown>, observed: Promise<unknown>): Promise<void> {
  let settled = false
  const result = observed.finally(() => { settled = true })
  while (!settled) {
    await act()
    await Promise.race([result, sleep(100)])
  }
  await result
}

/** Write `text` to `file` until `observed` settles. */
const change = (file: string, text: string, observed: Promise<unknown>): Promise<void> =>
  repeat(() => writeFile(file, text), observed)

/** Fake OpenSSH tools and a source daemon, so an alias can hold a real connection. */
async function remote(directory: string): Promise<Record<string, unknown>> {
  const node = process.execPath
  const fake = fileURLToPath(new URL('../../environment-ssh/tests/fixtures/fake-openssh.ts', import.meta.url))
  const entry = fileURLToPath(new URL('../../environment/src/daemon-entry.ts', import.meta.url))
  const metadata = { version: 'test-source', protocol: 3, node: '^24.22.3 || >=26.13.1' }
  const source = `// dsh-environment-daemon ${JSON.stringify(metadata)}\nawait import(${JSON.stringify(pathToFileURL(entry).href)})\n`
  vi.spyOn(Bootstrap, 'loadDaemon').mockResolvedValue({ source, ...metadata, digest: createHash('sha256').update(source).digest('hex') })
  const keyBase64 = randomBytes(32).toString('base64')
  const state = join(directory, 'state.json')
  await writeFile(state, JSON.stringify({
    hostname: 'box.example', port: '22', userKnownHosts: join(directory, 'user_known_hosts'), keyType: 'ssh-ed25519', keyBase64,
  }))
  return {
    ssh: [node, fake, 'ssh', state], sshKeygen: [node, fake, 'keygen', state], node,
    hostKeys: [`SHA256:${createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest('base64').replace(/=+$/, '')}`],
    knownHostsFile: join(directory, 'known_hosts'), daemonPath: join(directory, 'daemon.mjs'),
  }
}

/** The process id of the execution daemon serving `handle`. */
const daemonPid = (ctx: Context, handle: string): Promise<string> => ctx.environments.define(
  async (node: string, env) => (await env.exec([node, '-e', 'process.stdout.write(String(process.ppid))'])).stdout,
  { result: z.string() },
)(ctx.environments.handle(handle), process.execPath, { signal: new AbortController().signal })

describe('SSH configuration provider through Loader', () => {
  it('contributes multiple lazy SSH environments and removes them with their provider', async () => {
    const { ctx, file } = await boot()
    const id = await contribute(ctx, { file, ssh: shared })
    await ctx.loader.await()
    expect(ctx.environments.list()).toEqual([
      { handle: 'ssh-build', displayName: 'build' }, { handle: 'ssh-test', displayName: 'test' },
    ])
    await expect(ping(ctx, ctx.environments.handle('ssh-build'))).rejects.toThrow('configured-ssh')
    const fiber = ctx.loader.resolve(id).fiber!
    ctx.loader.remove(id)
    await fiber.await()
    expect(ctx.environments.list()).toEqual([])
  })

  it('skips registered handles and reconsiders them only when discovery reloads', async () => {
    const { ctx, file } = await boot()
    const explicit = await ctx.plugin(SshEnvironment, SshEnvironment.Config({
      host: 'build', displayName: 'Explicit build', ssh: ['/nonexistent/explicit-ssh'],
    }))
    const discovery = await contribute(ctx, { file, ssh: shared })
    const handle = ctx.environments.handle('ssh-build')
    expect(ctx.environments.list()).toEqual([
      { handle, displayName: 'Explicit build' }, { handle: 'ssh-test', displayName: 'test' },
    ])
    await expect(ping(ctx, handle)).rejects.toThrow('explicit-ssh')
    await explicit.dispose()
    expect(ctx.environments.list()).toEqual([{ handle: 'ssh-test', displayName: 'test' }])
    await ctx.loader.resolve(discovery).fiber!.restart()
    expect(ctx.environments.list()).toEqual([
      { handle, displayName: 'build' }, { handle: 'ssh-test', displayName: 'test' },
    ])
    await expect(ping(ctx, handle)).rejects.toThrow('configured-ssh')
  })

  it('preserves registered environments when discovery unloads and matches by handle', async () => {
    const { ctx, file } = await boot()
    await ctx.plugin(SshEnvironment, SshEnvironment.Config({ host: 'build', displayName: 'Explicit' }))
    const discovery = await contribute(ctx, { file, handlePrefix: 'work-', ssh: shared })
    expect(ctx.environments.list().map(environment => environment.handle)).toEqual(['ssh-build', 'work-build', 'work-test'])
    const fiber = ctx.loader.resolve(discovery).fiber!
    ctx.loader.remove(discovery)
    await fiber.await()
    expect(ctx.environments.list()).toEqual([{ handle: 'ssh-build', displayName: 'Explicit' }])
  })

  it('leaves collisions introduced after discovery to the registry', async () => {
    const { ctx, file } = await boot()
    await contribute(ctx, { file, ssh: shared })
    await expect(ctx.plugin(SshEnvironment, SshEnvironment.Config({ host: 'build' }))).rejects.toThrow('already registered')
    expect(ctx.environments.get(ctx.environments.handle('ssh-build')).displayName).toBe('build')
  })

  it('applies the configured alias allowlist and provider handle prefix', async () => {
    const { ctx, file } = await boot()
    await contribute(ctx, { file, hosts: ['test'], handlePrefix: 'work-', ssh: shared })
    await ctx.loader.await()
    expect(ctx.environments.list()).toEqual([{ handle: 'work-test', displayName: 'test' }])
  })

  it('reads the user configuration, contributes nothing when it is absent, and rejects another missing file', async () => {
    const { ctx, directory } = await boot()
    vi.stubEnv('HOME', directory)
    const file = join(directory, '.ssh', 'config')
    await remove(ctx, await contribute(ctx, { file, ssh: shared }))
    expect(ctx.environments.list()).toEqual([])
    await expect(contribute(ctx, { file: join(directory, 'missing_config'), ssh: shared })).rejects.toThrow('ENOENT')
    await writeFile(join(directory, '.ssh'), '')
    await expect(contribute(ctx, { file, ssh: shared })).rejects.toThrow('ENOTDIR')
    await rm(join(directory, '.ssh'))
    await mkdir(join(directory, '.ssh'))
    await writeFile(file, 'Host home-box\n')
    await contribute(ctx, { file, ssh: shared })
    expect(ctx.environments.list()).toEqual([{ handle: 'ssh-home-box', displayName: 'home-box' }])
  })

  it('validates common SSH settings when no aliases are discovered', async () => {
    const { ctx, file } = await boot()
    await writeFile(file, 'Host *\n  User nobody\n')
    await expect(contribute(ctx, { file, ssh: { ...shared, killGraceMs: 0 } })).rejects.toThrow()
    await expect(contribute(ctx, { file, ssh: { ...shared, unknownField: true } })).rejects.toThrow('unknownField')
  })

  it('rejects unknown aliases, identity overrides and invalid child configuration', async () => {
    const { ctx, file } = await boot()
    await expect(contribute(ctx, { file, hosts: ['missing'], ssh: shared }))
      .rejects.toThrow('not declared')
    await expect(contribute(ctx, { file, ssh: { ...shared, host: 'override' } }))
      .rejects.toThrow('ssh.host is supplied')
    await expect(contribute(ctx, { file, debounceMs: -1, ssh: shared })).rejects.toThrow()
    await writeFile(file, 'Host -bad build\n')
    await expect(contribute(ctx, { file, ssh: shared })).rejects.toThrow()
    expect(ctx.environments.list()).toEqual([])
    await writeFile(file, 'Host build test\n')
    await contribute(ctx, { file, ssh: {} })
    expect(ctx.environments.list()).toHaveLength(2)
  })
})

describe('SSH configuration changes through Loader', () => {
  it('adds and removes aliases, keeping unchanged aliases and their open connections', async () => {
    const { ctx, file, directory } = await boot()
    await contribute(ctx, { file, debounceMs: 10, ssh: await remote(directory) })
    const connected = await daemonPid(ctx, 'ssh-build')
    const seen: string[][] = []
    ctx.on('environments/change', () => { seen.push(handles(ctx)) })
    await change(file, 'Host build extra\n', listed(ctx, ['ssh-build', 'ssh-extra']))
    expect(seen).toEqual([['ssh-build'], ['ssh-build', 'ssh-extra']])
    expect(await daemonPid(ctx, 'ssh-build')).toBe(connected)
    await expect(ping(ctx, ctx.environments.handle('ssh-test'))).rejects.toThrow('"ssh-test" is not registered')
  })

  it('follows included files and the directories where included files can appear', async () => {
    const { ctx, file, directory } = await boot()
    vi.stubEnv('HOME', directory)
    const included = join(directory, '.ssh', 'config.d')
    await mkdir(included, { recursive: true })
    await writeFile(join(included, 'a.conf'), 'Host a\n')
    await writeFile(file, `Include config.d/*.conf ${directory}/later/hosts/*.conf\n`)
    await contribute(ctx, { file, debounceMs: 10, ssh: shared })
    expect(handles(ctx)).toEqual(['ssh-a'])
    await change(join(included, 'a.conf'), 'Host a a2\n', listed(ctx, ['ssh-a', 'ssh-a2']))
    await change(join(included, 'b.conf'), 'Host b\n', listed(ctx, ['ssh-a', 'ssh-a2', 'ssh-b']))
    await rm(join(included, 'a.conf'))
    await change(join(included, 'b.conf'), 'Host b\n', listed(ctx, ['ssh-b']))
    await mkdir(join(directory, 'later', 'hosts'), { recursive: true })
    await change(join(directory, 'later', 'hosts', 'c.conf'), 'Host c\n', listed(ctx, ['ssh-b', 'ssh-c']))
  })

  it('contributes the default user configuration once it appears, and nothing once it is removed', async () => {
    const { ctx, directory } = await boot()
    vi.stubEnv('HOME', directory)
    const file = join(directory, '.ssh', 'config')
    await contribute(ctx, { file, debounceMs: 10, ssh: shared })
    expect(handles(ctx)).toEqual([])
    await mkdir(join(directory, '.ssh'))
    await writeFile(file, 'Host home\n')
    await change(join(directory, 'unrelated'), '', listed(ctx, ['ssh-home']))
    await rm(file)
    await change(join(directory, '.ssh', 'unrelated'), '', listed(ctx, []))
  })

  it('keeps the previous aliases while the configuration cannot be read, and reports why', async () => {
    const { ctx, file, directory } = await boot()
    await contribute(ctx, { file, debounceMs: 10, ssh: shared })
    for (const [text, reason] of [
      ['Host "unterminated\n', /Cannot parse SSH configuration .*ssh_config: Unexpected line break/],
      [`Include ${file}\nHost extra\n`, /Include cycle/],
    ] as const) {
      const warning = warned(ctx, reason)
      await change(file, text, warning)
      expect(await warning).toMatch(/^Keeping the SSH Host aliases discovered before the last change: /)
      expect(handles(ctx)).toEqual(['ssh-build', 'ssh-test'])
    }
    const missing = warned(ctx, /ENOENT/)
    await rm(file)
    await change(join(directory, 'unrelated'), '', missing)
    await change(file, 'Host build\n', listed(ctx, ['ssh-build']))
  })

  it('removes an allowlisted alias that is no longer declared, reports it, and adds it back once declared', async () => {
    const { ctx, file } = await boot()
    await contribute(ctx, { file, hosts: ['build'], debounceMs: 10, ssh: shared })
    const warning = warned(ctx, /SSH Host alias "build" is no longer declared in .*ssh_config; its environment is removed/)
    await change(file, 'Host test\n', listed(ctx, []))
    await warning
    await change(file, 'Host build test\n', listed(ctx, ['ssh-build']))
  })

  it('leaves handles registered by other providers across changes, and takes over a released one at the next change', async () => {
    const { ctx, file } = await boot()
    const explicit = await ctx.plugin(SshEnvironment, SshEnvironment.Config({ host: 'build', displayName: 'Explicit build' }))
    await contribute(ctx, { file, debounceMs: 10, ssh: shared })
    await change(file, 'Host build test extra\n', listed(ctx, ['ssh-build', 'ssh-test', 'ssh-extra']))
    expect(ctx.environments.get(ctx.environments.handle('ssh-build')).displayName).toBe('Explicit build')
    await explicit.dispose()
    await change(file, 'Host build test\n', listed(ctx, ['ssh-test', 'ssh-build']))
    expect(ctx.environments.get(ctx.environments.handle('ssh-build')).displayName).toBe('build')
  })

  it('reports aliases it cannot add and adds the others', async () => {
    const { ctx, file } = await boot()
    await contribute(ctx, { file, debounceMs: 10, ssh: shared })
    const invalid = warned(ctx, /Cannot add SSH Host alias "-bad"/)
    await change(file, 'Host build test -bad good\n', listed(ctx, ['ssh-build', 'ssh-test', 'ssh-good']))
    await invalid
    // Another provider takes the handle while the alias's child provider starts.
    ctx.on('internal/plugin', (fiber: Fiber) => {
      const config = fiber.config as { host?: string } | undefined
      if (config?.host !== 'contested') return
      ctx.environments.register({ handle: ctx.environments.handle('ssh-contested'), displayName: 'Other' }, {
        open: () => Promise.reject(new Error('unused')),
      })
    })
    const contested = warned(ctx, /Cannot add SSH Host alias "contested" from .*ssh_config: .*already registered/)
    await change(file, 'Host build test good contested\n', contested)
    expect(ctx.environments.get(ctx.environments.handle('ssh-contested')).displayName).toBe('Other')
  })

  it('discovers again only after the configured time passes without further changes', async () => {
    const { ctx, file } = await boot()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await contribute(ctx, { file, debounceMs: 1000, ssh: shared })
    // One more discovery follows the start of watching.
    expect(vi.getTimerCount()).toBe(1)
    const scheduled = vi.spyOn(globalThis, 'setTimeout')
    const seen: string[][] = []
    ctx.on('environments/change', () => { seen.push(handles(ctx)) })
    await change(file, 'Host build test second\n', poll(() => scheduled.mock.calls.length > 0))
    vi.advanceTimersByTime(999)
    const calls = scheduled.mock.calls.length
    await change(file, 'Host build test third\n', poll(() => scheduled.mock.calls.length > calls))
    vi.advanceTimersByTime(999)
    expect(vi.getTimerCount()).toBe(1)
    expect(seen).toEqual([])
    vi.advanceTimersByTime(1)
    await listed(ctx, ['ssh-build', 'ssh-test', 'ssh-third'])
    expect(seen).toEqual([['ssh-build', 'ssh-test', 'ssh-third']])
  })

  it('stops discovery and watching when the provider is disposed', async () => {
    const { ctx, file } = await boot()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const disposed = await contribute(ctx, { file, handlePrefix: 'gone-', debounceMs: 1000, ssh: shared })
    const scheduled = vi.spyOn(globalThis, 'setTimeout')
    await change(file, 'Host build test second\n', poll(() => scheduled.mock.calls.length > 0))
    // The discovery that this timer starts is still reading files when disposal begins.
    vi.advanceTimersByTime(1000)
    await remove(ctx, disposed)
    expect(handles(ctx)).toEqual([])
    await contribute(ctx, { file, handlePrefix: 'kept-', debounceMs: 1000, ssh: shared })
    scheduled.mockClear()
    await change(file, 'Host build\n', poll(() => scheduled.mock.calls.length > 0))
    await new Promise(resolve => setImmediate(resolve))
    // The kept provider's change replaced its own pending discovery; the disposed provider scheduled none.
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(1000)
    await listed(ctx, ['kept-build'])
  })

  it('stops adding aliases when disposed while it adds them', async () => {
    const { ctx, file, directory } = await boot()
    const id = await contribute(ctx, { file, debounceMs: 10, ssh: shared })
    let removed: Promise<void> | undefined
    ctx.on('environments/change', () => {
      if (removed === undefined && handles(ctx).includes('ssh-first')) removed = remove(ctx, id)
    })
    // The new Include directory changes the watched directories, which asks for one more discovery.
    await mkdir(join(directory, 'more'))
    await writeFile(join(directory, 'more', 'hosts.conf'), 'Host build\n')
    await change(file, `Include ${directory}/more/*.conf\nHost build test first second\n`, poll(() => removed !== undefined))
    await removed
    expect(handles(ctx)).toEqual([])
  })

  it('reports a rediscovery that fails and rediscovers again at the next change', async () => {
    const { ctx, file } = await boot()
    await contribute(ctx, { file, debounceMs: 10, ssh: shared })
    // The rediscovery that follows loading fails while it updates the watched directories.
    vi.spyOn(DirectoryWatch.prototype, 'update').mockRejectedValueOnce(new Error('watchers unavailable'))
    await warned(ctx, /^SSH configuration rediscovery failed: .*watchers unavailable/)
    await change(file, 'Host build test extra\n', listed(ctx, ['ssh-build', 'ssh-test', 'ssh-extra']))
  })

  it('reports a directory it cannot watch and keeps its environments', async () => {
    const { ctx, file } = await boot()
    watching.refusal = Object.assign(new Error('System limit for number of file watchers reached'), { code: 'ENOSPC' })
    const warning = warned(ctx, /Cannot watch .* for SSH configuration changes: .*System limit/)
    await contribute(ctx, { file, ssh: shared })
    await warning
    expect(handles(ctx)).toEqual(['ssh-build', 'ssh-test'])
  })
})
