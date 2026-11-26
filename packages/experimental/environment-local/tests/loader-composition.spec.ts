import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import EnvironmentRegistry from '@deepseek-ai/dsh-environment'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import * as LocalEnvironment from '../src/index.ts'

let ctx: Context | undefined
let directory: string | undefined
const daemon = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-environment/src/daemon-entry.ts'))
/** Run an empty function once in a registered environment. */
const ping = (ctx: Context, handle: string): Promise<null> =>
  ctx.environments.define(() => null, { result: z.null() })(ctx.environments.handle(handle), null, { signal: new AbortController().signal })

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

async function boot(config: Record<string, unknown> = {}, registry: Record<string, unknown> = {}): Promise<Context> {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-local-env-')))
  const modules = {
    registry: EnvironmentRegistry, subprocess: LocalSubprocess, sandbox: LocalSandbox, policy: SandboxPolicy, local: LocalEnvironment,
  }
  const local = { handle: 'local-test', displayName: 'Local test', cwd: directory, daemon, ...config }
  const file = join(directory, 'cordis.yml')
  await writeFile(file, [
    '- name: cordis:registry', '  config:', `    ${JSON.stringify(registry)}`,
    '- name: cordis:subprocess', '- name: cordis:sandbox',
    '- name: cordis:policy', '  config:', '    mode: danger-full-access',
    '- name: cordis:local', '  config:', `    ${JSON.stringify(local)}`,
  ].join('\n') + '\n')
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  Object.assign(ctx.loader.builtins, modules)
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

describe('local environment through Loader', () => {
  it('registers metadata and runs filesystem, process and origin calls in a separate process', async () => {
    const ctx = await boot()
    expect(ctx.environments.list()).toEqual([{ handle: 'local-test', displayName: 'Local test' }])
    const seen: string[] = []
    const write = ctx.environments.define(async (node: string, env) => {
      const file = env.path.join(env.cwd, 'result.txt')
      await env.fs.writeFile(file, 'local output')
      const recorded = await env.origin.record(file)
      const process = await env.exec([node, '-e', 'process.stdout.write(String(process.ppid))'])
      return { file, recorded, parent: Number(process.stdout), cwd: env.cwd }
    }, {
      result: z.object({ file: z.string(), recorded: z.number(), parent: z.number(), cwd: z.string() }),
      handlers: { record: (file: string) => seen.push(file) },
    })
    const result = await write(ctx.environments.handle('local-test'), process.execPath, { signal: new AbortController().signal })
    expect(result.parent).not.toBe(process.pid)
    expect(result.cwd).toBe(directory)
    expect(seen).toEqual([result.file])
    expect(await readFile(result.file, 'utf8')).toBe('local output')
    expect(result.recorded).toBe(1)
  })

  it('ends an active execution process and its exec child when the provider is disposed', async () => {
    const owner = await boot({ killGraceMs: 1000 }, { killGraceMs: 2000 })
    const file = join(directory!, 'active-pid')
    const hold = owner.environments.define(async ({ node, file }: { node: string; file: string }, env) => {
      return await env.exec([node, '-e', `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(file)}, String(process.pid)); setInterval(() => {}, 1000)`])
    }, { result: z.unknown() })
    const pending = hold(owner.environments.handle('local-test'), { node: process.execPath, file }, { signal: new AbortController().signal })
    const rejected = expect(pending).rejects.toThrow()
    let pid = 0
    await vi.waitFor(async () => { pid = Number(await readFile(file, 'utf8')); expect(pid).toBeGreaterThan(0) })
    try {
      await owner.fiber.dispose()
      await rejected
      await vi.waitFor(() => { expect(() => process.kill(pid, 0)).toThrow() })
    } finally {
      try { process.kill(pid, 'SIGKILL') } catch (error) {
        // ESRCH: normal disposal already ended the child.
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
  })

  it('rejects a combined shutdown grace that would overflow Node timers', async () => {
    const owner = await boot({ killGraceMs: 2_147_483_647 })
    await expect(ping(owner, 'local-test')).rejects.toThrow('combined exec and daemon termination grace exceeds the Node timer limit')
  })

  it('reports process startup failures and invalid provider configuration', async () => {
    const ctx = await boot({ node: '/nonexistent/environment-node' })
    await expect(ping(ctx, 'local-test')).rejects.toThrow('environment-node')
  })

  it('rejects a relative working directory', async () => {
    await expect(boot({ cwd: 'relative' })).rejects.toThrow('cwd must be absolute')
  })

  it('resolves the installed default daemon lazily without starting a process', async () => {
    const ctx = await boot({ daemon: undefined })
    expect(ctx.environments.list()).toEqual([{ handle: 'local-test', displayName: 'Local test' }])
  })

  it('reports a daemon that exits and a working directory that cannot be started', async () => {
    const ctx = await boot({ daemon: '/nonexistent/environment-daemon.js' })
    await expect(ping(ctx, 'local-test')).rejects.toThrow('Local environment exited with code')
    const id = await ctx.loader.create({ name: 'cordis:local', config: {
      handle: 'bad-cwd', displayName: 'Bad cwd', cwd: '/nonexistent/environment-cwd', daemon,
    } })
    await ctx.loader.resolve(id).fiber!.await()
    await expect(ping(ctx, 'bad-cwd')).rejects.toThrow('Local environment failed')
  })

  it('withdraws a contributed environment when its provider is removed', async () => {
    const ctx = await boot()
    const id = await ctx.loader.create({ name: 'cordis:local', config: {
      handle: 'temporary', displayName: 'Temporary', cwd: directory, daemon,
    } })
    await ctx.loader.await()
    const key = ctx.environments.handle('temporary')
    await expect(ctx.environments.define(() => 3, { result: z.number() })(key, null, { signal: new AbortController().signal }))
      .resolves.toBe(3)
    const fiber = ctx.loader.resolve(id).fiber!
    ctx.loader.remove(id)
    await fiber.await()
    expect(() => ctx.environments.get(key)).toThrow('not registered')
    expect(ctx.environments.list()).toEqual([{ handle: 'local-test', displayName: 'Local test' }])
  })
})
