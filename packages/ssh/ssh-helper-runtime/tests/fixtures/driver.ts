/** Test-only Loader consumer exercising files, processes, terminals and PTC through the SSH providers. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-ssh'
import type {} from '@deepseek-ai/dsh-fs-ssh'
import type {} from '@deepseek-ai/dsh-subprocess-ssh'
import type {} from '@deepseek-ai/dsh-sandbox-ssh'
import type {} from '@deepseek-ai/dsh-ptc-runtime-node'

const [configPath, reportPath, sandbox] = process.argv.slice(2)
if (configPath === undefined || reportPath === undefined || !['required', 'unavailable', 'portable'].includes(sandbox ?? '')) throw new Error('Artifact driver requires config, report, and expected sandbox availability')
const ctx = await boot('ssh-helper-artifact', configPath)
const checks: string[] = []
const cleanupErrors: string[] = []
const diagnostics = new Context()
diagnostics.logger = ctx.logger
diagnostics.logger.exporter({ levels: { default: 2 }, export: ({ type, args }) => {
  if (type === 'error') cleanupErrors.push(args.map(value => String(value)).join(' '))
} })

async function completed(handle: SubprocessHandle): Promise<string> {
  const outcome = await handle.done
  assert.equal(await handle.waitForExit(), true)
  assert.deepEqual(outcome, { exitCode: 0, signal: null })
  return handle.collected.stdout?.readFrom(0).text ?? ''
}

try {
  const hello = await ctx.ssh.ready
  const root = hello.workspace
  assert.equal(hello.kind, 'executable')
  assert.equal(ctx.ssh.ptcLaunch.kind, 'embedded')
  checks.push('executable-handshake')

  const target = await ctx.fs.resolve(`${root}/sample.txt`)
  await ctx.fs.writeText(target, 'first\n你好\n')
  assert.equal(await ctx.fs.readText(target), 'first\n你好\n')
  assert.equal(Buffer.from(await ctx.fs.readByteRange(target, { offset: 0, length: 5 })).toString(), 'first')
  assert.equal(Buffer.from(await ctx.fs.readBytes(target, undefined, 1024)).toString(), 'first\n你好\n')
  await ctx.fs.editText(target, { oldString: 'first', newString: 'second', replaceAll: false })
  assert.equal(await ctx.fs.readText(target), 'second\n你好\n')
  let streamed = ''
  for await (const part of await ctx.fs.streamText(target)) streamed += part
  assert.equal(streamed, 'second\n你好\n')
  assert((await ctx.fs.listDir(await ctx.fs.resolve(root))).some(entry => entry.name === 'sample.txt'))
  await assert.rejects(ctx.fs.writeText(target, 'denied', undefined, undefined, { mode: 'read-only', workspaceRoot: root }))
  checks.push('guarded-files-and-streams')

  const options = { cwd: root, graceMs: 1000, stdio: { stdin: 'ignore', stdout: { maxBytes: 65_536 }, stderr: { maxBytes: 65_536 } } } as const
  const ordinary = ctx.subprocess.spawn({ ...options, argv: ['/bin/sh', '-c', 'printf "ordinary"; printf "diagnostic" >&2'] })
  assert.equal(await completed(ordinary), 'ordinary')
  assert.equal(ordinary.collected.stderr?.readFrom(0).text, 'diagnostic')
  checks.push('managed-process-output')
  if (process.env.DSH_VERIFY_NO_NODE === '1') {
    assert.equal(await completed(ctx.subprocess.spawn({ ...options, argv: ['/bin/sh', '-c', 'set -e; if command -v node; then exit 90; fi; test ! -e /usr/bin/node; test ! -e /usr/local/bin/node; printf no-node'] })), 'no-node')
    checks.push('target-has-no-node')
  }

  const sleeping = ctx.subprocess.spawn({ ...options, stdio: { ...options.stdio, stdout: 'pipe' }, argv: ['/bin/sh', '-c', 'printf ready; exec /bin/sleep 60'] })
  await new Promise<void>((resolve, reject) => {
    const stdout = sleeping.stdout!
    let text = ''
    const cleanup = (): void => { clearTimeout(timer); stdout.off('data', read); stdout.off('error', failed); stdout.off('end', ended) }
    const failed = (error: Error): void => { cleanup(); reject(error) }
    const ended = (): void => { failed(new Error('Sleeping process exited before readiness')) }
    const read = (bytes: Buffer): void => { text += bytes.toString(); if (text.includes('ready')) { cleanup(); resolve() } }
    const timer = setTimeout(() => { failed(new Error('Sleeping process did not become ready')) }, 10_000)
    stdout.on('data', read); stdout.once('error', failed); stdout.once('end', ended)
  })
  sleeping.terminate()
  await sleeping.done
  assert.equal(await sleeping.waitForExit(), true)
  sleeping.stdout?.destroy()
  checks.push('process-cancellation')

  const terminal = await ctx.subprocess.spawnTerminal({ argv: ['/bin/sh'], cwd: root, env: {}, terminalType: 'xterm', cols: 80, rows: 24, graceMs: 1000 })
  let terminalText = ''
  const terminalRead = (async () => { for await (const bytes of terminal.output) terminalText += Buffer.from(bytes).toString() })()
  try {
    await terminal.resize(100, 35)
    await terminal.write("stty size; printf 'pty-result:%s\\n' 42; exit\n")
    assert.equal((await terminal.done).exitCode, 0)
    await terminalRead
    assert(terminalText.includes('pty-result:42'))
    assert(terminalText.includes('35 100'))
  } finally { await terminal.terminate(); await terminalRead }
  checks.push('native-pty')

  const runtime = ctx.ptcRuntime
  const bindings = [{ global: 'tools', functions: { echo: async (input: unknown) => String(input) } }]
  const policy = { mode: 'danger-full-access', workspaceRoot: root } as const
  const result = await runtime.run(runtime.resolve({
    program: 'const fs=await import("node:fs/promises"); await fs.writeFile("ptc.txt","embedded"); console.log("worker-output"); return {value:await tools.echo("bridge"),env:Object.keys(process.env),executable:process.execPath,cwd:process.cwd()};',
    bindings, cwd: root, sandboxPolicy: policy,
  }))
  assert.equal(result.error, undefined, JSON.stringify(result))
  assert.deepEqual(result.value, { value: 'bridge', env: [], executable: hello.executable, cwd: root })
  assert(result.logs.join('').includes('worker-output'))
  assert.equal(await ctx.fs.readText(await ctx.fs.resolve(`${root}/ptc.txt`)), 'embedded')
  const locked = await runtime.run(runtime.resolve({
    program: 'const fs=await import("node:fs"); const {tryLockExclusive}=await import("@deepseek-ai/node-addon-system/flock"); const fd=fs.openSync("native-lock","w"); try { await tryLockExclusive(fd); return "locked" } finally { fs.closeSync(fd) }',
    bindings: [], cwd: root, sandboxPolicy: policy,
  }))
  assert.equal(locked.error, undefined, JSON.stringify(locked))
  assert.equal(locked.value, 'locked')
  checks.push('native-flock')
  const timed = await runtime.run(runtime.resolve({ program: 'while(true){}', bindings: [], cwd: root, sandboxPolicy: policy, timeoutMs: 1500 }))
  assert.equal(timed.error?.kind, 'timeout')
  checks.push('embedded-ptc-and-deadline')

  if (sandbox === 'required') {
    const runner = process.env.DSH_EXPECT_SANDBOX_RUNNER
    if (runner !== undefined) {
      const invocation = await ctx.sandbox.confine(['/bin/sh', '-c', 'true'], { mode: 'read-only', workspaceRoot: root })
      assert.equal(basename(invocation.argv[0]!), runner)
    }
    const confined = await runtime.run(runtime.resolve({
      program: 'return await (await import("node:fs/promises")).readFile("ptc.txt","utf8")', bindings: [], cwd: root,
      sandboxPolicy: { mode: 'read-only', workspaceRoot: root },
    }))
    assert.equal(confined.error, undefined, JSON.stringify(confined))
    assert.equal(confined.value, 'embedded')
    const denied = await runtime.run(runtime.resolve({
      program: 'await(await import("node:fs/promises")).writeFile("forbidden.txt","bad")', bindings: [], cwd: root,
      sandboxPolicy: { mode: 'read-only', workspaceRoot: root },
    }))
    assert.equal(denied.sandbox?.denied, true, JSON.stringify(denied))
    checks.push('sandbox-enforcement')
  } else if (sandbox === 'unavailable') {
    await assert.rejects(ctx.sandbox.confine(['/bin/sh', '-c', 'true'], { mode: 'read-only', workspaceRoot: root }), /sandbox|runner/i)
    checks.push('sandbox-unavailable-refusal')
  }
  await writeFile(reportPath, `${JSON.stringify({ checks, platform: hello.platform, nodeVersion: hello.nodeVersion, sandboxLane: sandbox }, null, 2)}\n`)
} finally {
  try { await ctx.fiber.dispose() }
  finally { await diagnostics.fiber.dispose() }
  assert.deepEqual(cleanupErrors, [], 'Loader or provider cleanup reported errors')
}
