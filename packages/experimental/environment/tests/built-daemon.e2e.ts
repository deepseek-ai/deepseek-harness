import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { EnvironmentHandle } from '../src/handle.ts'
import EnvironmentRegistry from '../src/index.ts'

/** Keyless deployment smoke: copy the standalone daemon bundle outside the repository and serve over stdio. */

const daemon = fileURLToPath(new URL('../lib/daemon.js', import.meta.url))

describe.skipIf(!existsSync(daemon))('built daemon bundle (plain node, outside the repository)', () => {
  it('runs a standalone stdio execution process and terminates it on disposal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-rx-'))
    const ctx = new Context()
    const stopped: Promise<Error>[] = []
    onTestFinished(async () => {
      await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    })
    const copy = join(directory, 'daemon.js')
    await copyFile(daemon, copy)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalSandbox, {})
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access' })
    await ctx.plugin(EnvironmentRegistry, {
      maxFrameBytes: 65536, maxMessageBytes: 1024 * 1024, maxPending: 4, cancelGraceMs: 10_000, killGraceMs: 2000, connectTimeoutMs: 10_000,
    })
    const built = EnvironmentHandle('built')
    ctx.environments.register({ handle: built, displayName: 'Built daemon' }, {
      async open() {
        const handle = ctx.subprocess.spawn({
          argv: [process.execPath, copy, 'serve', '--stdio'], cwd: directory, graceMs: 2000,
          stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 4096 } },
        })
        const ended = handle.done.then(outcome => new Error(`daemon exited with ${outcome.exitCode}: ${handle.collected.stderr?.readFrom(0).text ?? ''}`))
        stopped.push(ended)
        return { input: handle.stdout!, output: handle.stdin!, security: { kind: 'authenticated-transport' }, ended, close: () => { handle.terminate() } }
      },
    })
    const print = ctx.environments.define(async (node: string, env) => (await env.exec([node, '-e', 'process.stdout.write("built")'])).stdout,
      { result: z.string() })
    const value = await print(built, process.execPath, { signal: new AbortController().signal })
    expect(value).toBe('built')
    // The bundled worker supplies base utilities, and a reused definition runs from the connection's definition cache.
    const encode = ctx.environments.define((text: string) => Buffer.from(new TextEncoder().encode(text)).toString('base64'),
      { result: z.string() })
    await expect(encode(built, 'built', { signal: new AbortController().signal })).resolves.toBe(Buffer.from('built').toString('base64'))
    await expect(print(built, process.execPath, { signal: new AbortController().signal })).resolves.toBe('built')
    // Binary values over the frame limit travel as several frames in both directions.
    const reverse = ctx.environments.define((bytes: Uint8Array) => bytes.toReversed(), { result: z.instanceof(Uint8Array) })
    const bytes = new Uint8Array(200_000).map((_, index) => index % 251)
    await expect(reverse(built, bytes, { signal: new AbortController().signal })).resolves.toEqual(bytes.toReversed())
    await ctx.fiber.dispose()
    expect(stopped).toHaveLength(1)
    await stopped[0]
  })
})
