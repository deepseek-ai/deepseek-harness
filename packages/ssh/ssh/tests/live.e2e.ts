/** Opt-in acceptance against an explicitly configured, disposable POSIX SSH workspace. */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { once } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { NodePtcRuntime } from '@deepseek-ai/dsh-ptc-runtime-node'
import Lsp from '@deepseek-ai/dsh-lsp'
import * as LspStdio from '@deepseek-ai/dsh-lsp-stdio'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SshFileSystem } from '@deepseek-ai/dsh-fs-ssh'
import { SshSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh'
import { SshSandboxProvider } from '@deepseek-ai/dsh-sandbox-ssh'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { SshConnection, type Config } from '../src/index.ts'
import { doneSchema, preparedSchema } from '../src/schemas.ts'

const configPath = process.env.DSH_SSH_TEST_CONFIG
const bootstrap = process.env.DSH_SSH_TEST_BOOTSTRAP
const languageServer = process.env.DSH_SSH_TEST_LSP
const enabled = configPath !== undefined && process.platform !== 'win32'

async function setup() {
  const config = JSON.parse(readFileSync(configPath as string, 'utf8')) as Config
  const ctx = new Context()
  const projection = ctx.plugin(SessionProjectionRegistry)
  const policy = ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: config.workspace })
  const connection = ctx.plugin(SshConnection, config)
  const fs = ctx.plugin(SshFileSystem)
  const subprocess = ctx.plugin(SshSubprocessRuntime)
  const sandbox = ctx.plugin(SshSandboxProvider)
  const fibers = [projection, policy, connection, fs, subprocess, sandbox]
  const dispose = async (): Promise<void> => { for (const fiber of fibers.reverse()) await fiber.dispose() }
  try {
    await Promise.all(fibers)
    const hello = await ctx.ssh.ready
    const root = `${hello.workspace}/ssh-test-${randomUUID()}`
    const initial = await ctx.fs.resolve(`${root}/initial`)
    await ctx.fs.writeText(initial, 'initial')
    return { ctx, hello, root, dispose }
  } catch (error) { await dispose(); throw error }
}

async function processResult(handle: SubprocessHandle) {
  const result = await handle.done
  expect(await handle.waitForExit()).toBe(true)
  return { ...result, stdout: handle.collected.stdout?.readFrom(0).text, stderr: handle.collected.stderr?.readFrom(0).text }
}

async function removeOwned(test: Awaited<ReturnType<typeof setup>>) {
  try {
    const handle = test.ctx.subprocess.spawn({
      argv: [test.hello.node, '-e', 'require("node:fs").rmSync(process.argv[1],{recursive:true,force:true})', test.root],
      cwd: test.hello.workspace, stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 500,
    })
    await processResult(handle)
  } finally { await test.dispose() }
}

describe.skipIf(!enabled)('POSIX SSH runtime acceptance', () => {
  it('refuses same-user sandboxed connectors before granting a process stream', async () => {
    const test = await setup()
    try {
      const prepared = await test.ctx.ssh.request('process.prepare', {
        argv: [test.hello.node, '-e', 'process.stdout.write("legitimate-target")'], cwd: test.root, graceMs: 500,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', control: 'pipe' },
      }, preparedSchema)
      const endpoint = prepared.streams.control!
      const attack = "let connected=false,secure=false;const s=require('node:tls').connect({path:process.argv[1],ciphers:'PSK-AES256-GCM-SHA384',minVersion:'TLSv1.2',maxVersion:'TLSv1.2',pskCallback:()=>({identity:'dsh-stream',psk:Buffer.alloc(32)}),checkServerIdentity:()=>undefined});s.on('connect',()=>{connected=true});s.on('secureConnect',()=>{secure=true});s.on('error',()=>{});s.on('close',()=>process.stdout.write(JSON.stringify({connected,secure})));"
      const attacker = test.ctx.subprocess.spawn({
        argv: (await test.ctx.sandbox.confine([test.hello.node, '-e', attack, endpoint.path], {
          mode: 'read-only', workspaceRoot: test.root,
        })).argv,
        cwd: test.root, stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 500,
      })
      const observed = await processResult(attacker)
      expect(observed.exitCode).toBe(0)
      expect(JSON.parse(observed.stdout as string)).toEqual({ connected: true, secure: false })
      const sockets = await Promise.all(Object.entries(prepared.streams).map(async ([name, value]) =>
        [name, await test.ctx.ssh.connectStream(value)] as const))
      const output: Buffer[] = []
      for (const [name, socket] of sockets) {
        socket.end()
        socket.on('data', (chunk) => { if (name === 'stdout') output.push(Buffer.from(chunk)) })
        socket.resume()
      }
      await test.ctx.ssh.request('process.start', { id: prepared.id }, z.object({}).strict())
      const result = await test.ctx.ssh.request('process.done', { id: prepared.id }, doneSchema, undefined, true)
      expect(result.outcome.exitCode).toBe(0)
      await Promise.all(sockets.map(async ([, socket]) => {
        if (!socket.destroyed) await once(socket, 'close')
      }))
      expect(Buffer.concat(output).toString()).toBe('legitimate-target')
    } finally { await removeOwned(test) }
  }, 60_000)

  it('shares guarded file mutations, byte reads, shell cwd and symlink identity', async () => {
    const test = await setup()
    const { ctx, root, hello } = test
    try {
      const target = await ctx.fs.resolve(`${root}/text.txt`)
      const first = await ctx.fs.writeText(target, 'alpha\n', { kind: 'createIfAbsent' })
      await expect(ctx.fs.writeText(target, 'stale', { kind: 'replaceIfVersion', version: 'stale' as never }))
        .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
      const edited = await ctx.fs.editText(target, { oldString: 'alpha', newString: 'beta', replaceAll: false }, { version: first.version })
      expect(edited).toMatchObject({ before: 'alpha\n', after: 'beta\n' })
      expect(Buffer.from(await ctx.fs.readByteRange(target, { offset: 1, length: 3 })).toString()).toBe('eta')
      const chunks = []
      for await (const chunk of await ctx.fs.streamText(target)) chunks.push(chunk)
      expect(chunks.join('')).toBe('beta\n')
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: root }
      const argv = (await ctx.sandbox.confine(['/bin/bash', '-c', 'cat text.txt; printf "shell\n" > text.txt'], policy)).argv
      const result = await processResult(ctx.subprocess.spawn({
        argv, cwd: root, stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 500,
      }))
      expect(result).toMatchObject({ exitCode: 0, stdout: 'beta\n', stderr: '' })
      expect(await ctx.fs.readText(target)).toBe('shell\n')
      await expect(ctx.fs.writeText(target, 'denied', undefined, undefined, { ...policy, mode: 'read-only' }))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      const createLink = 'const fs=require(\'node:fs\');const root=process.argv[1];fs.mkdirSync(root+\'/physical/child\',{recursive:true});fs.mkdirSync(root+\'/lexical\');fs.symlinkSync(root+\'/physical/child\',root+\'/lexical/link\');'
      await processResult(ctx.subprocess.spawn({
        argv: [hello.node, '-e', createLink, root], cwd: root,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 500,
      }))
      const resolved = await ctx.fs.resolve('file.txt', { cwd: `${root}/lexical/link/..` })
      expect(ctx.fs.processPath(resolved)).toBe(`${root}/physical/file.txt`)
      expect(ctx.fs.fileUrl(resolved)).toBe(`file://${root}/physical/file.txt`)
      await ctx.fs.writeText(resolved, 'physical')
      expect(await ctx.fs.readText(await ctx.fs.resolve(`${root}/physical/file.txt`))).toBe('physical')
    } finally { await removeOwned(test) }
  }, 60_000)

  it('preserves binary fd 7 through native ownership and read-only confinement', async () => {
    const test = await setup()
    try {
      const code = 'const fs=require(\'node:fs\');const s=new(require(\'node:net\').Socket)({fd:7,readable:true,writable:true,allowHalfOpen:true});let a=[];s.on(\'data\',b=>a.push(b));s.on(\'end\',()=>{let denied;try{fs.writeFileSync(\'forbidden\',\'bad\')}catch(e){denied=e.code}process.stdout.write(JSON.stringify({pid:process.pid,denied,cgroup:process.platform===\'linux\'?fs.readFileSync(\'/proc/self/cgroup\',\'utf8\'):\'\'}));process.stderr.write(\'stderr\');s.end(Buffer.concat(a))});'
      const argv = (await test.ctx.sandbox.confine([test.hello.node, '-e', code], { mode: 'read-only', workspaceRoot: test.root })).argv
      const handle = test.ctx.subprocess.spawn({
        argv, cwd: test.root,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 }, control: 'pipe' }, graceMs: 1000,
      })
      const bytes = Buffer.from(Array.from({ length: 128 * 1024 }, (_, index) => index % 256))
      const chunks: Buffer[] = []
      const receiving = (async () => { for await (const chunk of handle.control!) chunks.push(Buffer.from(chunk as Uint8Array)) })()
      handle.control!.end(bytes)
      const result = await processResult(handle)
      await receiving
      expect(Buffer.concat(chunks)).toEqual(bytes)
      expect(result).toMatchObject({ exitCode: 0, stderr: 'stderr' })
      const facts = JSON.parse(result.stdout as string) as { pid: number; denied: string; cgroup: string }
      expect(['EROFS', 'EPERM', 'EACCES']).toContain(facts.denied)
      if (test.hello.platform === 'linux') {
        expect(facts.pid).toBe(2)
        expect(facts.cgroup).toMatch(/dsh-subprocess-[^\n]+\.scope/)
      }
    } finally { await removeOwned(test) }
  }, 60_000)

  it('keeps control and cancellation moving while stdout is paused', async () => {
    const test = await setup()
    let handle: SubprocessHandle | undefined
    try {
      const code = 'const s=new(require(\'node:net\').Socket)({fd:7,readable:true,writable:true});const b=Buffer.alloc(65536,120);let n=0;function pump(){while(n<10000){n++;if(!process.stdout.write(b))return}}process.stdout.on(\'drain\',pump);s.on(\'data\',v=>s.write(v));pump();setInterval(()=>{},1000);'
      handle = test.ctx.subprocess.spawn({
        argv: (await test.ctx.sandbox.confine([test.hello.node, '-e', code], { mode: 'workspace-write', workspaceRoot: test.root })).argv,
        cwd: test.root, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 1024 }, control: 'pipe' }, graceMs: 500,
      })
      const reply = once(handle.control!, 'data')
      handle.control!.write('control-progress')
      expect(Buffer.from((await reply)[0]).toString()).toBe('control-progress')
      expect(handle.stdout!.readableFlowing).not.toBe(true)
      const inspected = await test.ctx.fs.stat(await test.ctx.fs.resolve(`${test.root}/initial`))
      expect(inspected?.type).toBe('file')
      handle.terminate()
      expect(await handle.waitForExit()).toBe(true)
      handle.stdout!.resume()
      await handle.done
    } finally {
      handle?.terminate()
      handle?.stdout?.resume()
      await removeOwned(test)
    }
  }, 60_000)

  it('owns a remote terminal through input, inspection and teardown', async () => {
    const test = await setup()
    try {
      const terminal = await test.ctx.subprocess.spawnTerminal({
        terminalType: 'dumb', argv: ['/bin/bash', '--noprofile', '--norc', '-i'], cwd: test.root, rows: 24, cols: 80, graceMs: 500,
      })
      const output: string[] = []
      const received = Promise.withResolvers<undefined>()
      terminal.output.on('data', (chunk: Buffer) => {
        output.push(chunk.toString())
        if (output.join('').includes('terminal-proof')) received.resolve(undefined)
      })
      try {
        await terminal.write('printf "terminal-proof\\n"\n')
        await received.promise
        expect((await terminal.inspectForeground())?.processGroupId).toBeGreaterThan(0)
      } finally { await terminal.terminate() }
      expect((await terminal.done).exitCode).not.toBeUndefined()
    } finally { await removeOwned(test) }
  }, 60_000)

  it('reports unknown outcomes on disconnect and stops the remote managed descendants without replay', async () => {
    const observer = await setup()
    const victim = await setup()
    const victimConnection = victim.ctx.ssh
    try {
      const code = 'const fs=require(\'node:fs\');require(\'node:child_process\').spawn(process.execPath,[\'-e\',\'setInterval(()=>{},1000)\'],{detached:true,stdio:\'ignore\'}).unref();fs.appendFileSync(\'launches\',\'one\\n\');process.stdout.write(fs.readFileSync(\'/proc/self/cgroup\',\'utf8\'));setInterval(()=>{},1000);'
      const handle = victim.ctx.subprocess.spawn({
        argv: [victim.hello.node, '-e', code], cwd: victim.root,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 4096 } }, graceMs: 500,
      })
      const [bytes] = await once(handle.stdout!, 'data') as [Buffer]
      const scope = `/sys/fs/cgroup${Buffer.from(bytes).toString().trim().split('::')[1]}`
      expect(scope).toMatch(/dsh-subprocess-[^\n]+\.scope$/)
      const scopeTarget = await observer.ctx.fs.resolve(scope)
      expect(await observer.ctx.fs.stat(scopeTarget)).toBeDefined()
      const sshChild = Reflect.get(victim.ctx.ssh, 'child') as ChildProcess
      sshChild.kill('SIGKILL')
      await expect(handle.done).rejects.toThrow(/disconnect|closed|SSH/i)
      await expect(handle.waitForExit()).rejects.toThrow()
      const deadline = Date.now() + 40_000
      while (await observer.ctx.fs.stat(scopeTarget)) {
        if (Date.now() >= deadline) throw new Error('SSH disconnect retained its remote managed scope')
        await delay(100)
      }
      expect(await observer.ctx.fs.readText(await observer.ctx.fs.resolve(`${victim.root}/launches`))).toBe('one\n')
    } finally {
      await victim.dispose().catch(() => {})
      await victimConnection.dispose()
      try {
        await processResult(observer.ctx.subprocess.spawn({
          argv: [observer.hello.node, '-e', 'require("node:fs").rmSync(process.argv[1],{recursive:true,force:true})', victim.root],
          cwd: observer.root, stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 500,
        }))
      } finally { await removeOwned(observer) }
    }
  }, 60_000)

  it.skipIf(bootstrap === undefined)('runs PTC remotely with empty environment, bindings, denial and a bounded hot loop', async () => {
    const test = await setup()
    const fiber = test.ctx.plugin(NodePtcRuntime, {
      nodeExecutable: test.ctx.ssh.nodeExecutable, bootstrapPath: test.ctx.ssh.bootstrapPath,
    })
    try {
      await fiber
      const runtime = test.ctx.ptcRuntime
      const bindings = [{ global: 'tools', functions: { echo: async (input: unknown) => String(input) } }]
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: test.root }
      const result = await runtime.run(runtime.resolve({
        program: 'const fs=await import(\'node:fs/promises\');await fs.writeFile(\'ptc.txt\',\'node\');return {where:process.cwd(),env:Object.keys(process.env),echo:await tools.echo(\'host binding\')}',
        bindings, cwd: test.root, sandboxPolicy: policy,
      }))
      expect(result).toMatchObject({ value: { where: test.root, env: [], echo: 'host binding' }, sandbox: { mode: 'workspace-write' } })
      expect(result.error).toBeUndefined()
      expect(await test.ctx.fs.readText(await test.ctx.fs.resolve(`${test.root}/ptc.txt`))).toBe('node')
      const denied = await runtime.run(runtime.resolve({
        program: 'await(await import(\'node:fs/promises\')).writeFile(\'denied.txt\',\'bad\')', bindings, cwd: test.root,
        sandboxPolicy: { ...policy, mode: 'read-only' },
      }))
      expect(denied).toMatchObject({ error: { kind: 'exception' }, sandbox: { denied: true } })
      const timed = await runtime.run(runtime.resolve({ program: 'while(true){}', bindings, cwd: test.root, sandboxPolicy: policy, timeoutMs: 1500 }))
      expect(timed.error?.kind).toBe('timeout')
    } finally { await fiber.dispose(); await removeOwned(test) }
  }, 60_000)

  it.skipIf(languageServer === undefined)('queries a remote TypeScript language server through the shared filesystem and subprocess providers', async () => {
    const test = await setup()
    const lsp = test.ctx.plugin(Lsp)
    let stdio: ReturnType<Context['plugin']> | undefined
    try {
      await lsp
      await test.ctx.fs.writeText(await test.ctx.fs.resolve(`${test.root}/tsconfig.json`), '{"compilerOptions":{"strict":true}}')
      await test.ctx.fs.writeText(await test.ctx.fs.resolve(`${test.root}/source.ts`), 'export const answer: number = 42\nexport const doubled = answer * 2\n')
      stdio = test.ctx.plugin(LspStdio, { servers: { remoteTypescript: {
        command: test.hello.node, args: [languageServer as string, '--stdio'], extensionToLanguage: { '.ts': 'typescript' },
      } } })
      await stdio
      const request = { filePath: 'source.ts', workspaceRoot: test.root, position: { line: 1, character: 24 } }
      const definition = await test.ctx.lsp.query({ ...request, operation: 'goToDefinition' })
      expect(definition).toMatchObject({ kind: 'locations', resolvedWorkspaceUri: `file://${test.root}` })
      if (definition.kind === 'locations') expect(definition.locations).toContainEqual(expect.objectContaining({ uri: `file://${test.root}/source.ts` }))
      const hover = await test.ctx.lsp.query({ ...request, operation: 'hover' })
      expect(hover.kind).toBe('hover')
      if (hover.kind === 'hover') expect(hover.hover?.contents).toContain('number')
    } finally { await stdio?.dispose(); await lsp.dispose(); await removeOwned(test) }
  }, 60_000)

  it('rejects a mismatched helper artifact before exposing remote operations', async () => {
    const config = JSON.parse(readFileSync(configPath as string, 'utf8')) as Config
    const ctx = new Context()
    const fiber = ctx.plugin(SshConnection, { ...config, helperHash: '0'.repeat(64) })
    try { await expect(fiber).rejects.toThrow('digest differs') }
    finally { await fiber.dispose() }
  }, 60_000)
})
