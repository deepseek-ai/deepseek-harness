import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { HarnessError, ToolCallId } from '@deepseek-ai/dsh-llm'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as NativeToolRegistry from '@deepseek-ai/dsh-tool-registry-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { EnvironmentHandle } from '../src/handle.ts'
import EnvironmentRegistry, {
  type Config, type EnvironmentConfirmation, type EnvironmentDefineOptions, type EnvironmentErrorCode, type EnvironmentFunction,
  type EnvironmentHandlers, type EnvironmentOpenContext, type EnvironmentRunner, type EnvironmentValue,
} from '../src/index.ts'

const withCode = (code: EnvironmentErrorCode): Record<string, string> =>
  expect.objectContaining({ name: 'EnvironmentError', code }) as Record<string, string>

import { decodeFrames } from './fixtures/frames.ts'
import * as StdioTransport from './fixtures/stdio-transport.ts'
import { serveConnection } from '../src/daemon.ts'
import { ENVIRONMENT_PROTOCOL_VERSION, RpcPeer } from '../src/protocol.ts'

/** Define `fn` and call it once, for tests of a single run. */
function runOnce<A extends EnvironmentValue, T, H extends EnvironmentHandlers = Record<never, never>>(
  registry: EnvironmentRegistry, handle: EnvironmentHandle, fn: EnvironmentFunction<A, NoInfer<H>>, args: A,
  options: EnvironmentDefineOptions<T, H> & Parameters<EnvironmentRunner<A, T>>[2],
): Promise<T> {
  return registry.define(fn, options)(handle, args, options)
}

const node = process.execPath
/** Limits of the in-process daemon peers some tests build. */
const peerLimits = { maxFrameBytes: 65536, maxMessageBytes: 65536, maxPending: 4, cancelGraceMs: 1000 }
/** A trust question whose English text is `detail`. */
const question = (detail: string): EnvironmentConfirmation => ({ hostname: 'box', port: 22, keys: [], detail })
const daemonEntry = fileURLToPath(new URL('../src/daemon-entry.ts', import.meta.url))
let context: Context | undefined
let root: string | undefined
const selections = new WeakMap<Context, EnvironmentHandle>()
const target = (ctx: Context): EnvironmentHandle => selections.get(ctx)!

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A tool split into daemon I/O, a host state change reached from the daemon, and model formatting. */
const readTracked = {
  name: 'test-read-tracked',
  inject: ['tools', 'environments'],
  apply(ctx: Context) {
    const read = new Set<string>()
    const readFile = ctx.environments.define(async ({ path, node }: { path: string; node: string }, env) => {
      const text = await env.fs.readFile(path, 'utf8')
      const first = await env.origin.markRead(path)
      const daemon = (await env.exec([node, '-e', 'process.stdout.write(String(process.ppid))'])).stdout
      return { text, first, daemon }
    }, {
      result: z.object({ text: z.string(), first: z.boolean(), daemon: z.string() }),
      handlers: {
        markRead: (path: string) => {
          const first = !read.has(path)
          read.add(path)
          return first
        },
      },
    })
    ctx.tools.register(defineTool({
      name: 'read_tracked',
      description: 'Read a file on the remote machine and record it as read.',
      parameters: { path: { type: 'string', required: true }, node: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true }, first: { type: 'boolean', required: true }, daemon: { type: 'string', required: true } } },
        render: (args, value) => [{ type: 'text', text: `${args.path}${value.first ? '' : ' (read before)'}: ${value.text} [${value.daemon}]` }],
      },
      execute: (args, exec) => readFile(EnvironmentHandle('local'), { path: args.path, node: args.node }, { signal: exec.signal }),
    }))
  },
}

const serve = [node, daemonEntry, 'serve', '--stdio']

async function boot(command: readonly string[], config: Partial<Config> & { environment?: string } = {}, cwd?: string): Promise<Context> {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-environment-')))
  const { environment = 'local', ...limits } = config
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-registry-native', NativeToolRegistry],
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-sandbox-local', LocalSandbox],
    ['@deepseek-ai/dsh-sandbox-policy', SandboxPolicyService],
    ['@deepseek-ai/dsh-environment', EnvironmentRegistry],
    ['test-read-tracked', readTracked],
    ['test-stdio-transport', StdioTransport],
  ])
  const lines = [...modules.keys()].flatMap(name => [
    `- name: 'cordis:${name}'`,
    ...name === '@deepseek-ai/dsh-sandbox-policy' ? ['  config:', '    mode: danger-full-access'] : [],
    ...name === '@deepseek-ai/dsh-environment' ? ['  config:', `    ${JSON.stringify(limits)}`] : [],
    ...name === 'test-stdio-transport' ? ['  config:', `    ${JSON.stringify({ environment: 'local', command, cwd: cwd ?? root })}`] : [],
  ])
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, lines.join('\n') + '\n')
  context = new Context()
  selections.set(context, EnvironmentHandle(environment))
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  for (const [specifier, plugin] of modules) context.loader.builtins[specifier] = plugin
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  for (const entry of context.loader.entries()) await entry.fiber?.await()
  return context
}

const text = (result: { content: { type: string; text?: string }[] }) => result.content.map(block => block.text ?? '').join('')
let nextCall = 0
const invoke = (ctx: Context, path: string, signal = new AbortController().signal) => executeToolFixture(ctx, {
  name: 'read_tracked', callId: ToolCallId(`call-${++nextCall}`), arguments: { path, node }, signal,
})

describe('execution environment through real Loader composition', () => {
  it('runs daemon I/O, a host state change and formatting for each call in one long-lived daemon', async () => {
    const ctx = await boot(serve)
    const file = join(root!, 'note.txt')
    await writeFile(file, 'remote text')
    const first = await invoke(ctx, file)
    const second = await invoke(ctx, file)
    expect(first.isError).not.toBe(true)
    const daemon = (first.value as { daemon: string }).daemon
    expect(text(first)).toBe(`${file}: remote text [${daemon}]`)
    expect(text(second)).toBe(`${file} (read before): remote text [${daemon}]`)
    expect(Number(daemon)).not.toBe(process.pid)
  })

  it('calls typed handlers and preserves omitted parameters and undefined results', async () => {
    const ctx = await boot(serve)
    const recorded: string[] = []
    const record: (text: string) => void = text => recorded.push(text)
    const signal = new AbortController().signal
    const value = await runOnce(ctx.environments, target(ctx), async (_args, env) => ({
      marked: await env.origin.mark({ path: 'note.txt' }),
      optional: await env.origin.optional(),
      explicit: await env.origin.optional('text'),
      nullable: await env.origin.nullable(null),
      count: await env.origin.count(),
      notified: await env.origin.notify(),
      recorded: await env.origin.record('note.txt'),
    }), null, {
      signal,
      result: z.object({
        marked: z.boolean(), optional: z.string(), explicit: z.string(), nullable: z.boolean(),
        count: z.number(), notified: z.undefined(), recorded: z.number(),
      }),
      handlers: {
        mark: async (params: { path: string }, handlerSignal: AbortSignal) => {
          expect(handlerSignal.aborted).toBe(false)
          return params.path === 'note.txt'
        },
        optional: (params?: string) => params === undefined ? 'omitted' : params,
        nullable: (params: null) => params === null,
        count: () => 42,
        notify: () => {},
        record,
      },
    })
    expect(value).toEqual({ marked: true, optional: 'omitted', explicit: 'text', nullable: true, count: 42, notified: undefined, recorded: 1 })
    expect(Object.hasOwn(value, 'notified')).toBe(true)
    expect(recorded).toEqual(['note.txt'])
  })

  it('exposes own handlers, enumerable or not, as own origin methods and supports calls without a receiver', async () => {
    const ctx = await boot(serve)
    const signal = new AbortController().signal
    const handlers = {
      echo: (text: string) => text,
      toString: () => 'handler',
      ['__proto__']: () => true,
      hidden: () => 'hidden',
    }
    Object.defineProperty(handlers, 'hidden', { enumerable: false })
    const result = await runOnce(ctx.environments, target(ctx), async (_args, env) => {
      const origin = await Promise.resolve(env.origin)
      const { echo, toString: stringify } = origin
      return {
        keys: Object.keys(origin).sort(),
        echoed: await echo('text'),
        named: await stringify(),
        special: await origin.__proto__(),
        hidden: typeof origin.hidden,
      }
    }, null, {
      signal,
      result: z.object({
        keys: z.array(z.string()), echoed: z.string(), named: z.string(), special: z.boolean(), hidden: z.string(),
      }),
      handlers,
    })
    expect(result).toEqual({
      keys: ['__proto__', 'echo', 'hidden', 'toString'], echoed: 'text', named: 'handler', special: true, hidden: 'function',
    })
    await expect(runOnce(ctx.environments, target(ctx), (_args, env) => ({
      keys: Object.keys(env.origin),
      ownsConstructor: Object.hasOwn(env.origin, 'constructor'),
      nativeHelper: typeof env.origin.toString === 'function',
      thenable: 'then' in env.origin,
    }), null, {
      signal,
      result: z.object({ keys: z.array(z.string()), ownsConstructor: z.boolean(), thenable: z.boolean(), nativeHelper: z.boolean() }),
    })).resolves.toEqual({ keys: [], ownsConstructor: false, thenable: false, nativeHelper: true })
    await expect(runOnce(ctx.environments, target(ctx), (_args, env) => env.origin.then('text'), null, {
      signal, result: z.number(), handlers: { then: (text: string) => text.length },
    })).resolves.toBe(4)
  })

  it('fixes the handler names when defining and looks each handler up on its object when called', async () => {
    const ctx = await boot(serve)
    const handlers: Record<string, () => string> = { kept: () => 'kept', removed: () => 'removed' }
    const call = ctx.environments.define(async (_args: null, env) => ({
      methods: Object.keys(env.origin),
      kept: await env.origin.kept!(),
      removed: await env.origin.removed!().then(() => 'served', (error: unknown) => (error as Error).message),
    }), { result: z.object({ methods: z.array(z.string()), kept: z.string(), removed: z.string() }), handlers })
    handlers.kept = () => 'replaced'
    delete handlers.removed
    handlers.added = () => 'added'
    await expect(call(target(ctx), null, { signal: new AbortController().signal })).resolves
      .toEqual({ methods: ['kept', 'removed'], kept: 'replaced', removed: 'Unknown host handler: removed' })
  })

  it('lists provider metadata and executes different environments concurrently', async () => {
    const ctx = await boot(serve)
    const second = join(root!, 'second')
    await mkdir(second)
    await ctx.loader.create({ name: 'cordis:test-stdio-transport', config: { environment: 'build', command: serve, cwd: second } })
    await ctx.loader.await()
    expect(ctx.environments.list()).toEqual([
      { handle: 'local', displayName: 'local' }, { handle: 'build', displayName: 'build' },
    ])
    expect(ctx.environments.get(EnvironmentHandle('build'))).toEqual({ handle: 'build', displayName: 'build' })
    // One definition runs in whichever environment each call names.
    const write = ctx.environments.define(async (text: string, env) => {
      await env.fs.writeFile(env.path.join(env.cwd, 'written.txt'), text)
      return env.cwd
    }, { result: z.string() })
    const options = { signal: new AbortController().signal }
    await expect(Promise.all([
      write(EnvironmentHandle('local'), 'local output', options),
      write(EnvironmentHandle('build'), 'build output', options),
    ])).resolves.toEqual([root, second])
    expect(await readFile(join(root!, 'written.txt'), 'utf8')).toBe('local output')
    expect(await readFile(join(second, 'written.txt'), 'utf8')).toBe('build output')
  })

  it('keeps concurrent calls of one definition and their handler signals separate', async () => {
    const ctx = await boot(serve)
    const entered = new Map<string, AbortSignal>()
    const bothEntered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const echo = ctx.environments.define(async (label: string, env) => {
      await env.origin.hold(label)
      return label
    }, {
      result: z.string(),
      handlers: {
        hold: async (label: string, signal: AbortSignal) => {
          entered.set(label, signal)
          if (entered.size === 2) bothEntered.resolve(undefined)
          await Promise.race([release.promise, new Promise((resolve) => { signal.addEventListener('abort', resolve) })])
        },
      },
    })
    const first = new AbortController()
    const cancelled = echo(target(ctx), 'first', { signal: first.signal })
    const kept = echo(target(ctx), 'second', { signal: new AbortController().signal })
    await bothEntered.promise
    first.abort(new Error('stop first'))
    await expect(cancelled).rejects.toThrow('stop first')
    expect(entered.get('first')?.aborted).toBe(true)
    expect(entered.get('second')?.aborted).toBe(false)
    release.resolve(undefined)
    await expect(kept).resolves.toBe('second')
  })

  it('keeps origin handlers scoped to the connection owning their run', async () => {
    const ctx = await boot(serve)
    const started = Promise.withResolvers<number>()
    const release = Promise.withResolvers<string>()
    let invoked = 0
    for (const name of ['owner', 'other']) {
      ctx.environments.register({ handle: EnvironmentHandle(name), displayName: 'Same display name' }, {
        async open() {
          const toDaemon = new PassThrough()
          const toHost = new PassThrough()
          const peer: RpcPeer = new RpcPeer(toDaemon, toHost, peerLimits, async (method, params) => {
            if (method === 'auth') return { mechanism: 'transport' }
            const { run } = z.object({ run: z.number() }).parse(params)
            if (name === 'owner') {
              started.resolve(run)
              return await release.promise
            }
            try {
              await peer.request('call', { run: await started.promise, method: 'secret', params: null })
              return 'accepted'
            } catch (error) {
              return (error as Error).message
            }
          })
          return {
            input: toHost, output: toDaemon, security: { kind: 'authenticated-transport' }, ended: peer.closed,
            close: () => { toDaemon.end(); toHost.end() },
          }
        },
      })
    }
    const signal = new AbortController().signal
    const owner = runOnce(ctx.environments, EnvironmentHandle('owner'), () => null, null, {
      signal, result: z.string(), handlers: { secret: () => { invoked++; return 'secret' } },
    })
    await started.promise
    try {
      await expect(runOnce(ctx.environments, EnvironmentHandle('other'), () => null, null, { signal, result: z.string() }))
        .resolves.toBe('Execution environment run is no longer active')
      expect(invoked).toBe(0)
    } finally {
      release.resolve('done')
      await owner
    }
  })

  it('emits environments/change once per registration and effective unregistration, after list() reflects it', async () => {
    const ctx = await boot(serve)
    const seen: string[][] = []
    ctx.on('environments/change', () => { seen.push(ctx.environments.list().map(({ handle }) => handle)) })
    const id = await ctx.loader.create({ name: 'cordis:test-stdio-transport', config: { environment: 'build', command: serve, cwd: root } })
    await ctx.loader.await()
    expect(seen).toEqual([['local', 'build']])
    // Hot reloading disposes the provider's fiber and applies the provider again.
    await ctx.loader.resolve(id).fiber!.restart()
    expect(seen.slice(1)).toEqual([['local'], ['local', 'build']])
    const fiber = ctx.loader.resolve(id).fiber!
    ctx.loader.remove(id)
    await fiber.await()
    expect(seen.slice(3)).toEqual([['local']])
    expect(() => ctx.environments.get(EnvironmentHandle('build'))).toThrow('not registered')
    const info = { handle: EnvironmentHandle('direct'), displayName: 'Direct' }
    const transport = { open: () => Promise.reject(new Error('unused')) }
    const dispose = ctx.environments.register(info, transport)
    expect(() => ctx.environments.register(info, transport)).toThrow('already registered')
    dispose()
    dispose()
    const replacement = ctx.environments.register(info, transport)
    dispose()
    replacement()
    expect(seen.slice(4)).toEqual([['local', 'direct'], ['local'], ['local', 'direct'], ['local']])
  })

  it('logs failing change listeners without undoing the change or skipping other listeners', async () => {
    const ctx = await boot(serve)
    const warnings: string[] = []
    ctx.logger.exporter({ export: (message) => { if (message.type === 'warn') warnings.push(String(message.args[0])) } })
    ctx.on('environments/change', () => { throw new Error('listener threw') })
    // oxlint-disable-next-line typescript/no-misused-promises -- exercises rejected-listener containment
    ctx.on('environments/change', () => Promise.reject(new Error('listener rejected')))
    const seen: number[] = []
    ctx.on('environments/change', () => { seen.push(ctx.environments.list().length) })
    const dispose = ctx.environments.register({ handle: EnvironmentHandle('observed'), displayName: 'Observed' }, {
      open: () => Promise.reject(new Error('unused')),
    })
    dispose()
    expect(seen).toEqual([2, 1])
    await vi.waitFor(() => { expect(warnings).toHaveLength(4) })
    expect(warnings.sort()).toEqual([
      'An environments/change listener failed: listener rejected', 'An environments/change listener failed: listener rejected',
      'An environments/change listener failed: listener threw', 'An environments/change listener failed: listener threw',
    ])
  })

  it('lets a change listener replace a removed registration without joining its aborted connection', async () => {
    const ctx = await boot(serve)
    const handle = EnvironmentHandle('replaced-by-listener')
    const opened: string[] = []
    const run = ctx.environments.define(() => 'ran', { result: z.string() })
    const signal = new AbortController().signal
    // The old registration's connection is still opening when the registration is removed.
    const dispose = ctx.environments.register({ handle, displayName: 'Old' }, {
      open: () => {
        opened.push('old')
        return new Promise(() => {})
      },
    })
    const waiting = run(handle, null, { signal })
    let replacement: Promise<string> | undefined
    ctx.on('environments/change', () => {
      if (replacement !== undefined || ctx.environments.list().some(environment => environment.handle === handle)) return
      ctx.environments.register({ handle, displayName: 'New' }, {
        async open() {
          opened.push('new')
          const toDaemon = new PassThrough()
          const toHost = new PassThrough()
          const ended = serveConnection({ input: toDaemon, output: toHost, mechanisms: ['transport'], authTimeoutMs: 1000 })
          return { input: toHost, output: toDaemon, security: { kind: 'authenticated-transport' }, ended, close: () => { toDaemon.end() } }
        },
      })
      replacement = run(handle, null, { signal })
    })
    dispose()
    await expect(waiting).rejects.toThrow('"replaced-by-listener" was unregistered')
    await expect(replacement).resolves.toBe('ran')
    expect(opened).toEqual(['old', 'new'])
  })

  it('does not let an old disposer remove a replacement with the same handle', async () => {
    const ctx = await boot(serve)
    const info = { handle: EnvironmentHandle('replace'), displayName: 'Replacement' }
    const transport = { open: async () => { throw new Error('not opened') } }
    const old = ctx.environments.register(info, transport)
    old()
    const replacement = ctx.environments.register(info, transport)
    old()
    expect(ctx.environments.get(info.handle)).toEqual(info)
    replacement()
    expect(() => ctx.environments.get(info.handle)).toThrow('not registered')
  })

  it('reports a daemon exit with its stderr, then starts a new daemon on the next run', async () => {
    const ctx = await boot(serve)
    const file = join(root!, 'note.txt')
    await writeFile(file, 'x')
    const before = (await invoke(ctx, file)).value as { daemon: string }
    const killed = runOnce(ctx.environments, target(ctx), (args: string, env) => env.exec([args, '-e', 'process.kill(process.ppid, "SIGKILL")']), node, {
      signal: new AbortController().signal, result: z.unknown(),
    })
    await expect(killed).rejects.toEqual(withCode('ENVIRONMENT_OUTCOME_UNKNOWN'))
    // Windows reports a forced termination as exit code 1 without a signal name.
    await expect(killed).rejects.toThrow('daemon exited with SIGKILL')
    const after = (await invoke(ctx, file)).value as { daemon: string }
    expect(after.daemon).not.toBe(before.daemon)
  })

  it('reports a launch command that exits before answering', async () => {
    const ctx = await boot([node, '-e', 'console.error("no daemon here"); process.exit(2)', '--'])
    const result = await invoke(ctx, '/unused')
    expect(result.isError).toBe(true)
    // The exit can close the connection before or after its output stream ends; either way it is reported once.
    const disconnected = '(?:Execution environment peer disconnected; the outcome of pending requests is unknown; )?'
    expect(text(result)).toMatch(new RegExp(`^(?:Error: )?${disconnected}daemon exited with code 2: no daemon here$`))
    expect(result.isError && result.error.info).toEqual(expect.objectContaining({ code: 'ENVIRONMENT_UNREACHABLE' }))
    const direct = runOnce(ctx.environments, target(ctx), () => null, null, { signal: new AbortController().signal, result: z.null() })
    await expect(direct).rejects.toEqual(withCode('ENVIRONMENT_UNREACHABLE'))
  })

  it('reports an exit once when it closes the connection before the output stream ends', async () => {
    // A grandchild keeps standard output open after the launch command exits.
    const script = "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: ['ignore', 'inherit', 'ignore'] }); console.error('gone'); process.exit(3)"
    const ctx = await boot([node, '-e', script, '--'])
    await expect(runOnce(ctx.environments, target(ctx), () => null, null, { signal: new AbortController().signal, result: z.null() }))
      .rejects.toThrow(/^daemon exited with code 3: gone$/)
  })

  it('reports a daemon that refuses the handshake, and one whose answer is invalid, without claiming an unknown outcome', async () => {
    /** A daemon that answers the first request with `fields` in one frame. */
    const answer = (fields: string): string => [
      "const v8 = require('node:v8')",
      "process.stdin.once('data', (data) => {",
      `  const body = v8.serialize({ id: v8.deserialize(data.subarray(4)).id, ${fields} })`,
      '  const header = Buffer.alloc(4)',
      '  header.writeUInt32BE(body.length)',
      '  process.stdout.write(Buffer.concat([header, body]))',
      '})',
    ].join('\n')
    const newer = `Execution environment daemon speaks protocol ${ENVIRONMENT_PROTOCOL_VERSION + 1}; the host speaks ${ENVIRONMENT_PROTOCOL_VERSION}`
    let first = true
    for (const [fake, message] of [
      [answer("type: 'result', value: { mechanism: 'other' }"), /Invalid input/],
      [answer(`type: 'error', error: { name: 'Error', message: '${newer}' }`), new RegExp(`^${newer}$`)],
    ] as const) {
      if (!first) await rm(root!, { recursive: true, force: true })
      first = false
      const ctx = await boot([node, '-e', fake, '--'])
      const refused = runOnce(ctx.environments, target(ctx), () => null, null, { signal: new AbortController().signal, result: z.null() })
      await expect(refused).rejects.toThrow(message)
      await expect(refused).rejects.toEqual(withCode('ENVIRONMENT_UNREACHABLE'))
      await context!.fiber.dispose()
    }
    context = undefined
  })

  it('fails unresolvable launch commands and retries them on the next run', async () => {
    const ctx = await boot(['/nonexistent/dsh-remote-daemon'])
    const run = () => runOnce(ctx.environments, target(ctx), () => null, null, { signal: new AbortController().signal, result: z.null() })
    await expect(run()).rejects.toThrow('is not an executable file')
    await expect(run()).rejects.toThrow('is not an executable file')
    // Disposal waits for a launch that is still failing, which its abort may end first.
    const failing = expect(run()).rejects.toThrow(/is not an executable file|Execution environment is disposed|"local" was unregistered/)
    await context!.fiber.dispose()
    context = undefined
    await failing
  })

  it('reports remote errors, unknown handlers, inactive runs and invalid results without restarting', async () => {
    const ctx = await boot(serve)
    const signal = new AbortController().signal
    const failed = runOnce(ctx.environments, target(ctx), () => { throw new Error('remote failure') }, null, { signal, result: z.null() })
    await expect(failed).rejects.toEqual(withCode('ENVIRONMENT_RUN_FAILED'))
    await expect(failed).rejects.toThrow(/^remote failure$/)
    await expect(failed).rejects.toHaveProperty('remote', { name: 'Error', message: 'remote failure' })
    const missing: EnvironmentFunction<null, { missing: () => null }> = (_args, env) => env.origin.missing()
    // @ts-expect-error -- an untyped remote caller can omit required handler implementations.
    await expect(runOnce(ctx.environments, target(ctx), missing, null, { signal, result: z.null() }))
      .rejects.toThrow('env.origin.missing is not a function')
    await expect(runOnce(ctx.environments, target(ctx), () => 'text', null, { signal, result: z.number() })).rejects.toThrow('Execution environment result failed validation')
  })

  it('refuses daemon calls for inactive runs, unknown host methods and handlers added after defining', async () => {
    const ctx = await boot([node, fileURLToPath(new URL('fixtures/stray-calls-daemon.ts', import.meta.url))])
    const handlers: Record<string, () => string> = {}
    const call = ctx.environments.define(() => null, { result: z.array(z.string()), handlers })
    handlers.added = () => 'added'
    await expect(call(target(ctx), null, { signal: new AbortController().signal })).resolves.toEqual([
      'Execution environment run is no longer active', 'Unknown host handler: toString', 'Unknown host handler: added',
      'Unknown execution environment host method: other',
    ])
  })

  it('aborts a run, then rejects new runs after disposal', async () => {
    const ctx = await boot(serve)
    const controller = new AbortController()
    const started = Promise.withResolvers<AbortSignal>()
    const pending = runOnce(ctx.environments, target(ctx), async (_args: null, env) => {
      await env.origin.hold()
      return null
    }, null, {
      signal: controller.signal,
      result: z.null(),
      handlers: {
        hold: (_params: unknown, signal: AbortSignal) => new Promise((resolve) => {
          started.resolve(signal)
          signal.addEventListener('abort', resolve)
        }),
      },
    })
    const handlerSignal = await started.promise
    controller.abort(new Error('stop'))
    // The host handler observes the abort without waiting for the daemon.
    expect(handlerSignal.aborted).toBe(true)
    await expect(pending).rejects.toThrow('stop')
    await expect(runOnce(ctx.environments, target(ctx), () => null, null, { signal: AbortSignal.abort(new Error('early')), result: z.null() })).rejects.toThrow('early')

    const service = ctx.environments
    const inflight = runOnce(service, EnvironmentHandle('local'), () => new Promise(() => {}), null, { signal: new AbortController().signal, result: z.null() })
    const stored = service.define(() => null, { result: z.null() })
    // The transport plugin unloads first, which closes the connection before the service itself is disposed.
    const rejected = expect(inflight).rejects.toThrow(/^Environment "local" was unregistered/)
    await context!.fiber.dispose()
    context = undefined
    await rejected
    await expect(stored(EnvironmentHandle('local'), null, { signal: new AbortController().signal })).rejects.toThrow('Execution environment is disposed')
  })

  it('stops waiting for a starting daemon on abort and stops starting it on disposal', async () => {
    const ctx = await boot(serve)
    const controller = new AbortController()
    const waiting = runOnce(ctx.environments, target(ctx), () => null, null, { signal: controller.signal, result: z.null() })
    controller.abort(new Error('gave up'))
    await expect(waiting).rejects.toThrow('gave up')
    await context!.fiber.dispose()
    await rm(root!, { recursive: true, force: true })

    const restarted = await boot(serve)
    const starting = runOnce(restarted.environments, target(restarted), () => null, null, {
      signal: new AbortController().signal, result: z.null(),
    })
    // Unloading the transport plugin aborts the open before the service itself is disposed.
    const rejected = expect(starting).rejects.toThrow(/Execution environment is disposed|"local" was unregistered/)
    await context!.fiber.dispose()
    context = undefined
    await rejected
  })

  it('reports a launch the subprocess provider cannot start', async () => {
    const ctx = await boot(serve, {}, '/nonexistent/dsh-environment')
    await expect(runOnce(ctx.environments, target(ctx), () => null, null, { signal: new AbortController().signal, result: z.null() }))
      .rejects.toThrow('daemon failed')
  })

  it('terminates a cancelled run that ignores its signal and keeps its daemon for later runs', async () => {
    const ctx = await boot(serve, { maxPending: 1, cancelGraceMs: 2000 })
    const signal = new AbortController().signal
    const daemon = ctx.environments.define(async (node: string, env) =>
      (await env.exec([node, '-e', 'process.stdout.write(String(process.ppid))'])).stdout, { result: z.string() })
    const before = await daemon(target(ctx), node, { signal })
    const controller = new AbortController()
    const started = Promise.withResolvers<undefined>()
    const stuck = runOnce(ctx.environments, target(ctx), async (_args: null, env) => {
      await env.origin.started()
      return await new Promise(() => {})
    }, null, { signal: controller.signal, result: z.null(), handlers: { started: () => { started.resolve(undefined) } } })
    await started.promise
    const refused = runOnce(ctx.environments, target(ctx), () => null, null, { signal, result: z.null() })
    await expect(refused).rejects.toEqual(withCode('ENVIRONMENT_REQUEST_REFUSED'))
    await expect(refused).rejects.toThrow('Execution environment pending request limit reached')
    controller.abort(new Error('stop'))
    await expect(stuck).rejects.toThrow('stop')
    // The run's slot returns when the daemon answers the cancellation; a host that waited out the grace would start a new daemon.
    await vi.waitFor(async () => {
      await expect(daemon(target(ctx), node, { signal })).resolves.toBe(before)
    }, { timeout: 10_000, interval: 100 })
  })

  it('serves other runs while a function blocks its worker', async () => {
    const ctx = await boot(serve, { cancelGraceMs: 400 })
    const signal = new AbortController().signal
    const controller = new AbortController()
    const started = Promise.withResolvers<undefined>()
    const blocked = runOnce(ctx.environments, target(ctx), async (_args: null, env) => {
      await env.origin.started()
      return /^(a+)+$/.test(`${'a'.repeat(64)}!`)
    }, null, { signal: controller.signal, result: z.boolean(), handlers: { started: () => { started.resolve(undefined) } } })
    await started.promise
    await expect(runOnce(ctx.environments, target(ctx), async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
      return 'served'
    }, null, { signal, result: z.string() })).resolves.toBe('served')
    controller.abort(new Error('stop'))
    await expect(blocked).rejects.toThrow('stop')
  })

  it('sends a definition once per connection and again after reconnecting', async () => {
    const ctx = await boot(serve)
    const handle = EnvironmentHandle('cached')
    const written: Buffer[][] = []
    const channels: { close(): void; ended: Promise<Error> }[] = []
    // Origin method names travel only inside a run's definition.
    const runRequest = z.object({
      run: z.number(), hash: z.string(), definition: z.object({ source: z.string(), methods: z.array(z.string()) }).strict().optional(),
      args: z.unknown(),
    }).strict()
    /** The runs the host sent on each connection. */
    const sent = () => written.map(chunks => decodeFrames(Buffer.concat(chunks))
      .filter(frame => frame.type === 'request' && frame.method === 'run')
      .map(frame => runRequest.parse(frame.params)))
    /** Whether each run the host sent on each connection carried its definition. */
    const carried = (): boolean[][] => sent().map(runs => runs.map(({ definition }) => definition !== undefined))
    const transport = {
      async open() {
        const chunks: Buffer[] = []
        written.push(chunks)
        const fromHost = new PassThrough()
        const toDaemon = new PassThrough()
        const toHost = new PassThrough()
        fromHost.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
          toDaemon.write(chunk)
        })
        // The host peer destroys its output when it closes, which ends the daemon's input too.
        fromHost.on('close', () => { toDaemon.end() })
        const ended = serveConnection({ input: toDaemon, output: toHost, mechanisms: ['transport'], authTimeoutMs: 1000 })
        const channel = { input: toHost, output: fromHost, security: { kind: 'authenticated-transport' as const }, ended, close: () => { toDaemon.end() } }
        channels.push(channel)
        return channel
      },
    }
    ctx.environments.register({ handle, displayName: 'Cached' }, transport)
    const signal = new AbortController().signal
    const increment = ctx.environments.define((n: number) => n + 1, { result: z.number() })
    const twin = ctx.environments.define((n: number) => n + 1, { result: z.number() })
    const other = ctx.environments.define((n: number) => n - 1, { result: z.number() })
    // Handler names belong to the definition, so equal source with other names is another definition.
    const handled = ctx.environments.define((n: number) => n + 1, { result: z.number(), handlers: { unused: () => null } })
    await expect(increment(handle, 1, { signal })).resolves.toBe(2)
    await expect(increment(handle, 2, { signal })).resolves.toBe(3)
    await expect(twin(handle, 3, { signal })).resolves.toBe(4)
    await expect(other(handle, 4, { signal })).resolves.toBe(3)
    await expect(handled(handle, 5, { signal })).resolves.toBe(6)
    await expect(handled(handle, 6, { signal })).resolves.toBe(7)
    expect(carried()).toEqual([[true, false, false, true, true, false]])
    const [runs] = sent()
    expect(runs!.map(({ definition }) => definition?.methods)).toEqual([[], undefined, undefined, [], ['unused'], undefined])
    expect(runs![4]!.definition?.source).toBe(runs![0]!.definition?.source)
    expect(runs![4]!.hash).not.toBe(runs![0]!.hash)
    channels[0]!.close()
    await channels[0]!.ended
    // The registry drops the closed connection in promise callbacks, which all run before the next macrotask.
    await new Promise(resolve => setImmediate(resolve))
    await expect(twin(handle, 5, { signal })).resolves.toBe(6)
    expect(carried()).toEqual([[true, false, false, true, true, false], [true]])
    // Another environment's connection receives the same definition on its own first run.
    const elsewhere = EnvironmentHandle('cached-elsewhere')
    ctx.environments.register({ handle: elsewhere, displayName: 'Cached elsewhere' }, transport)
    await expect(twin(elsewhere, 6, { signal })).resolves.toBe(7)
    await expect(twin(elsewhere, 7, { signal })).resolves.toBe(8)
    expect(carried()).toEqual([[true, false, false, true, true, false], [true], [true, false]])
  })

  it('names the registered environments when the configured one is missing, and refuses duplicates', async () => {
    const ctx = await boot(serve, { environment: 'elsewhere' })
    // Defining requires no registration; each call resolves the handle.
    const missing = ctx.environments.define(() => null, { result: z.null() })
    await expect(missing(target(ctx), null, { signal: new AbortController().signal })).rejects
      .toThrow('Environment "elsewhere" is not registered; registered: local')
    expect(() => ctx.environments.register({ handle: EnvironmentHandle('local'), displayName: 'local' }, { open: () => Promise.reject(new Error('unused')) })).toThrow('already registered')
    const owner = new Context()
    const empty = new EnvironmentRegistry(owner, {
      maxFrameBytes: 1024, maxMessageBytes: 1024, maxPending: 1, cancelGraceMs: 1, killGraceMs: 1, connectTimeoutMs: 1000,
    })
    await expect(runOnce(empty, EnvironmentHandle('none'), () => null, null, { signal: new AbortController().signal, result: z.null() })).rejects.toThrow('registered: none')
    await owner.fiber.dispose()
  })

  it('passes confirmation to the transport and closes the connection when its environment is unregistered', async () => {
    const ctx = await boot(serve, { environment: 'in-process' })
    const opens: EnvironmentOpenContext[] = []
    const answers: boolean[] = []
    const ended = Promise.withResolvers<Error>()
    const dispose = ctx.environments.register({ handle: EnvironmentHandle('in-process'), displayName: 'in-process' }, {
      open: async (open) => {
        opens.push(open)
        answers.push(await open.confirm!(question('d')))
        const toDaemon = new PassThrough()
        const toHost = new PassThrough()
        void serveConnection({ input: toDaemon, output: toHost, mechanisms: ['transport'], authTimeoutMs: 1000 }).then((reason) => { ended.resolve(reason) })
        return { input: toHost, output: toDaemon, security: { kind: 'authenticated-transport' }, ended: ended.promise, close: () => { toDaemon.end() } }
      },
    })
    const confirm = async () => true
    const signal = new AbortController().signal
    await expect(runOnce(ctx.environments, target(ctx), () => 1, null, { signal, result: z.number(), confirm })).resolves.toBe(1)
    expect(answers).toEqual([true])
    // Once no run waits for the connection, nobody can be asked.
    await expect(opens[0]!.confirm!(question('d'))).resolves.toBe(false)
    dispose()
    dispose()
    await expect(ended.promise).resolves.toBeInstanceOf(Error)
    await expect(runOnce(ctx.environments, target(ctx), () => 1, null, { signal: new AbortController().signal, result: z.number() }))
      .rejects.toThrow('Environment "in-process" is not registered; registered: local')
  })

  it('uses a confirmer that joins after opening started', async () => {
    const ctx = await boot(serve)
    const entered = Promise.withResolvers<undefined>()
    const continueOpen = Promise.withResolvers<undefined>()
    let asked = 0
    const handle = EnvironmentHandle('late-confirmer')
    ctx.environments.register({ handle, displayName: 'Late confirmer' }, {
      async open(open) {
        entered.resolve(undefined)
        await continueOpen.promise
        expect(await open.confirm!(question('fingerprint'))).toBe(true)
        const toDaemon = new PassThrough()
        const toHost = new PassThrough()
        const ended = serveConnection({ input: toDaemon, output: toHost, mechanisms: ['transport'], authTimeoutMs: 1000 })
        return { input: toHost, output: toDaemon, security: { kind: 'authenticated-transport' }, ended, close: () => { toDaemon.end() } }
      },
    })
    const signal = new AbortController().signal
    const first = runOnce(ctx.environments, handle, () => 1, null, { signal, result: z.number() })
    await entered.promise
    const second = runOnce(ctx.environments, handle, () => 2, null, {
      signal, result: z.number(), confirm: async () => { asked++; return true },
    })
    continueOpen.resolve(undefined)
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2])
    expect(asked).toBe(1)
  })

  it('does not redirect an in-progress run to a replacement registration', async () => {
    const ctx = await boot(serve)
    const key = EnvironmentHandle('replace-during-handshake')
    let disposeReplacement: (() => void) | undefined
    let replacementOpens = 0
    const disposeOld = ctx.environments.register({ handle: key, displayName: 'Old' }, {
      async open() {
        const toDaemon = new PassThrough()
        const toHost = new PassThrough()
        const ended = Promise.withResolvers<Error>()
        void ended.promise.then(() => {
          disposeOld()
          disposeReplacement = ctx.environments.register({ handle: key, displayName: 'Replacement' }, {
            async open() { replacementOpens++; throw new Error('replacement should not open') },
          })
        })
        const peer: RpcPeer = new RpcPeer(toDaemon, toHost, peerLimits, () => {
          const reason = new Error('closed during authentication')
          ended.resolve(reason)
          peer.close(reason)
          return new Promise(() => {})
        })
        return {
          input: toHost, output: toDaemon, security: { kind: 'authenticated-transport' }, ended: ended.promise,
          close() { peer.close(new Error('test finished')); toDaemon.end(); toHost.end() },
        }
      },
    })
    try {
      await expect(runOnce(ctx.environments, key, () => null, null, { signal: new AbortController().signal, result: z.null() }))
        .rejects.toThrow('was unregistered')
      expect(replacementOpens).toBe(0)
      expect(ctx.environments.get(key)).toEqual({ handle: key, displayName: 'Replacement' })
    } finally {
      disposeReplacement?.()
      disposeOld()
    }
  })

  it('publishes connection ownership before a provider can replace itself', async () => {
    const ctx = await boot(serve)
    const handle = EnvironmentHandle('reentrant')
    const oldClosed = Promise.withResolvers<undefined>()
    let disposeNew: (() => void) | undefined
    let newOpens = 0
    const channel = (label: string) => {
      const toDaemon = new PassThrough()
      const toHost = new PassThrough()
      const peer = new RpcPeer(toDaemon, toHost, peerLimits, async method =>
        method === 'auth' ? { mechanism: 'transport' } : label)
      return {
        input: toHost, output: toDaemon, security: { kind: 'authenticated-transport' as const }, ended: peer.closed,
        close() {
          peer.close(new Error('test finished'))
          toDaemon.end()
          toHost.end()
          if (label === 'old') oldClosed.resolve(undefined)
        },
      }
    }
    const disposeOld = ctx.environments.register({ handle, displayName: 'Old' }, {
      async open() {
        const old = channel('old')
        disposeOld()
        disposeNew = ctx.environments.register({ handle, displayName: 'New' }, {
          async open() { newOpens++; return channel('new') },
        })
        return old
      },
    })
    // One stored definition reaches whichever registration holds the called handle.
    const call = ctx.environments.define(() => null, { result: z.string() })
    const options = { signal: new AbortController().signal }
    try {
      await expect(call(handle, null, options)).rejects.toThrow('was unregistered')
      await oldClosed.promise
      await expect(call(handle, null, options)).resolves.toBe('new')
      expect(newOpens).toBe(1)
      expect(ctx.environments.get(handle).displayName).toBe('New')
    } finally {
      disposeNew?.()
      disposeOld()
    }
  })

  it('clears the connection deadline when a provider throws synchronously', async () => {
    const ctx = await boot(serve)
    const handle = EnvironmentHandle('synchronous-failure')
    ctx.environments.register({ handle, displayName: 'Synchronous failure' }, {
      open() { throw new Error('provider failed before returning a promise') },
    })
    vi.useFakeTimers()
    try {
      await expect(runOnce(ctx.environments, handle, () => null, null, { signal: new AbortController().signal, result: z.null() }))
        .rejects.toThrow('provider failed before returning a promise')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not restart a connection deadline when confirmation finishes after cancellation', async () => {
    const ctx = await boot(serve)
    const entered = Promise.withResolvers<undefined>()
    const decision = Promise.withResolvers<boolean>()
    const finished = Promise.withResolvers<undefined>()
    const handle = EnvironmentHandle('late-confirmation-result')
    ctx.environments.register({ handle, displayName: 'Late confirmation' }, {
      async open(open) {
        try {
          await open.confirm!(question('fingerprint'))
          throw new Error('confirmation finished after cancellation')
        } finally {
          finished.resolve(undefined)
        }
      },
    })
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const run = runOnce(ctx.environments, handle, () => null, null, {
        signal: controller.signal, result: z.null(),
        confirm: () => { entered.resolve(undefined); return decision.promise },
      })
      const rejected = expect(run).rejects.toThrow('cancelled caller')
      await entered.promise
      controller.abort(new Error('cancelled caller'))
      await rejected
      await ctx.fiber.dispose()
      context = undefined
      expect(vi.getTimerCount()).toBe(0)
      decision.resolve(false)
      await finished.promise
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      decision.resolve(false)
      vi.useRealTimers()
    }
  })

  it('stops waiting for a silent daemon on abort, and closes the open connection on disposal', async () => {
    const ctx = await boot(serve, { environment: 'silent' })
    const ended = Promise.withResolvers<Error>()
    ctx.environments.register({ handle: EnvironmentHandle('silent'), displayName: 'silent' }, {
      open: async () => ({
        input: new PassThrough(), output: new PassThrough(), security: { kind: 'authenticated-transport' },
        ended: ended.promise, close: () => { ended.resolve(new Error('silent channel closed')) },
      }),
    })
    const controller = new AbortController()
    const waiting = runOnce(ctx.environments, target(ctx), () => null, null, { signal: controller.signal, result: z.null() })
    await new Promise(resolve => setImmediate(resolve))
    controller.abort(new Error('gave up waiting'))
    await expect(waiting).rejects.toThrow('gave up waiting')
    await context!.fiber.dispose()
    context = undefined
    await expect(ended.promise).resolves.toEqual(new Error('silent channel closed'))
  })

  it('reconnects once when the channel ends during the handshake, and reports a second loss', async () => {
    const ctx = await boot(serve, { environment: 'flaky' })
    let opens = 0
    const daemon = (healthy: boolean) => {
      const toDaemon = new PassThrough()
      const toHost = new PassThrough()
      const ended = Promise.withResolvers<Error>()
      if (healthy) void serveConnection({ input: toDaemon, output: toHost, mechanisms: ['transport'], authTimeoutMs: 1000 }).then(ended.resolve)
      else toDaemon.once('data', () => { toHost.end(); ended.resolve(new Error('daemon went idle')) })
      return { input: toHost, output: toDaemon, security: { kind: 'authenticated-transport' as const }, ended: ended.promise, close: () => { toDaemon.end() } }
    }
    let healthyFrom = 2
    ctx.environments.register({ handle: EnvironmentHandle('flaky'), displayName: 'flaky' }, { open: async () => daemon(++opens >= healthyFrom) })
    await expect(runOnce(ctx.environments, target(ctx), () => 'second try', null, { signal: new AbortController().signal, result: z.string() })).resolves.toBe('second try')
    expect(opens).toBe(2)
    healthyFrom = Number.POSITIVE_INFINITY
    opens = 0
    await context!.fiber.dispose()
    const again = await boot(serve, { environment: 'flaky' })
    again.environments.register({ handle: EnvironmentHandle('flaky'), displayName: 'flaky' }, { open: async () => daemon(++opens >= healthyFrom) })
    const lost = runOnce(again.environments, target(again), () => null, null, { signal: new AbortController().signal, result: z.null() })
    await expect(lost).rejects.toThrow(/daemon went idle/)
    await expect(lost).rejects.toEqual(withCode('ENVIRONMENT_UNREACHABLE'))
    expect(opens).toBe(2)
  })

  it('times out an open that does not complete, excluding the time a person spends confirming', async () => {
    const ctx = await boot(serve, { environment: 'slow', connectTimeoutMs: 100 })
    const seen: AbortSignal[] = []
    ctx.environments.register({ handle: EnvironmentHandle('slow'), displayName: 'slow' }, {
      open: async (open) => {
        seen.push(open.signal)
        await open.confirm?.(question('slow person'))
        return await new Promise(() => {})
      },
    })
    const confirm = () => new Promise<boolean>(resolve => setTimeout(() => { resolve(true) }, 200))
    const timedOut = runOnce(ctx.environments, target(ctx), () => null, null, {
      signal: new AbortController().signal, result: z.null(), confirm,
    })
    await expect(timedOut).rejects.toThrow('Environment "slow" did not connect within 100 ms')
    expect(seen[0]!.aborted).toBe(true)
  })

  it('asks any waiting run that can confirm, and aborts an open once every waiting run has left', async () => {
    const ctx = await boot(serve, { environment: 'shared' })
    const asked: string[] = []
    const opening = Promise.withResolvers<AbortSignal>()
    const answered = Promise.withResolvers<boolean>()
    ctx.environments.register({ handle: EnvironmentHandle('shared'), displayName: 'shared' }, {
      open: async (open) => {
        opening.resolve(open.signal)
        answered.resolve(await open.confirm!(question('fingerprint')))
        return await new Promise(() => {})
      },
    })
    const first = new AbortController()
    const second = new AbortController()
    const silent = runOnce(ctx.environments, target(ctx), () => null, null, { signal: first.signal, result: z.null(), confirm: async () => { asked.push('first'); return await new Promise(() => {}) } })
    void silent.catch(() => {})
    const signal = await opening.promise
    first.abort(new Error('first left'))
    const waiting = runOnce(ctx.environments, target(ctx), () => null, null, { signal: second.signal, result: z.null(), confirm: async () => { asked.push('second'); return true } })
    await expect(silent).rejects.toThrow('first left')
    expect(signal.aborted).toBe(false)
    second.abort(new Error('second left'))
    await expect(waiting).rejects.toThrow('second left')
    expect(signal.aborted).toBe(true)
    expect(signal.reason).toEqual(new Error('Every run waiting for the execution environment connection was cancelled'))
    expect(asked).toEqual(['first'])
    void answered
  })

  it('closes a channel a transport hands over after its open was aborted', async () => {
    const ctx = await boot(serve, { environment: 'late' })
    const handOver = Promise.withResolvers<undefined>()
    const closed = Promise.withResolvers<undefined>()
    ctx.environments.register({ handle: EnvironmentHandle('late'), displayName: 'late' }, {
      open: async () => {
        await handOver.promise
        return { input: new PassThrough(), output: new PassThrough(), security: { kind: 'authenticated-transport' }, ended: new Promise(() => {}), close: () => { closed.resolve(undefined) } }
      },
    })
    const controller = new AbortController()
    const run = runOnce(ctx.environments, target(ctx), () => null, null, { signal: controller.signal, result: z.null() })
    controller.abort(new Error('gone'))
    await expect(run).rejects.toThrow('gone')
    handOver.resolve(undefined)
    await closed.promise
  })

  it('copies binary values and undefined in arguments, results and origin calls, and reports the message limit', async () => {
    const ctx = await boot(serve)
    expect(ctx.environments.limits).toEqual({ maxMessageBytes: 64 * 1024 * 1024 })
    const stored: unknown[] = []
    const value = await runOnce(ctx.environments, target(ctx), async (args: { bytes: Uint8Array; missing?: undefined }, env) => {
      const file = env.path.join(env.cwd, 'bytes.bin')
      await env.fs.writeFile(file, args.bytes)
      return {
        read: await env.fs.readFile(file), kept: 'missing' in args, limit: env.limits.maxMessageBytes,
        stored: await env.origin.store({ bytes: args.bytes, missing: undefined, at: new Date(0) }),
      }
    }, { bytes: new Uint8Array([0, 255, 128]), missing: undefined }, {
      signal: new AbortController().signal,
      result: z.object({ read: z.instanceof(Uint8Array), kept: z.boolean(), limit: z.number(), stored: z.undefined() }),
      handlers: { store: (params: { bytes: Uint8Array; missing?: undefined; at: Date }) => { stored.push(params) } },
    })
    expect(value).toEqual({ read: new Uint8Array([0, 255, 128]), kept: true, limit: 64 * 1024 * 1024, stored: undefined })
    // The daemon's worker boundary copies the Buffer that readFile returns as a plain Uint8Array.
    expect(Object.getPrototypeOf(value.read)).toBe(Uint8Array.prototype)
    expect(stored).toEqual([{ bytes: new Uint8Array([0, 255, 128]), missing: undefined, at: new Date(0) }])
    expect(Object.hasOwn(stored[0] as object, 'missing')).toBe(true)
  })

  it('sends messages over maxFrameBytes as several frames and refuses ones over maxMessageBytes on a connection it keeps', async () => {
    const ctx = await boot(serve, { maxFrameBytes: 1024, maxMessageBytes: 256 * 1024 })
    const signal = new AbortController().signal
    type RelayArgs = { data: Uint8Array; node: string; send: number; answer: number }
    const relay = ctx.environments.define(async ({ data, node, send, answer }: RelayArgs, env) => {
      const daemon = (await env.exec([node, '-e', 'process.stdout.write(String(process.ppid))'])).stdout
      const failure = (error: unknown) => (error as Error).message
      const sent = await env.origin.echo({ data: new Uint8Array(send), size: answer }).then(reply => reply.length, failure)
      return { data, daemon, sent }
    }, {
      result: z.object({ data: z.instanceof(Uint8Array), daemon: z.string(), sent: z.union([z.number(), z.string()]) }),
      handlers: { echo: ({ data, size }: { data: Uint8Array; size: number }) => size === 0 ? data : new Uint8Array(size) },
    })
    const data = new Uint8Array(100_000).map((_, index) => index % 251)
    const first = await relay(target(ctx), { data, node, send: 100_000, answer: 0 }, { signal })
    expect(first).toEqual({ data, daemon: first.daemon, sent: 100_000 })
    const over = 300 * 1024
    const refused = relay(target(ctx), { data: new Uint8Array(over), node, send: 0, answer: 0 }, { signal })
    await expect(refused).rejects.toEqual(withCode('ENVIRONMENT_REQUEST_REFUSED'))
    await expect(refused).rejects.toThrow(/^Execution environment message of 307\d{3} bytes exceeds maxMessageBytes \(262144\)$/)
    // Origin calls and their results over the limit fail inside the function.
    const origin = await relay(target(ctx), { data: new Uint8Array(0), node, send: over, answer: 0 }, { signal })
    expect(origin.sent).toMatch(/exceeds maxMessageBytes \(262144\)$/)
    const answer = await relay(target(ctx), { data: new Uint8Array(0), node, send: 0, answer: over }, { signal })
    expect(answer.sent).toMatch(/exceeds maxMessageBytes \(262144\)$/)
    const result = runOnce(ctx.environments, target(ctx), (size: number) => new Uint8Array(size), over, { signal, result: z.unknown() })
    await expect(result).rejects.toEqual(withCode('ENVIRONMENT_RUN_FAILED'))
    await expect(result).rejects.toThrow(/exceeds maxMessageBytes \(262144\)$/)
    // Every refusal kept the connection and its daemon.
    expect(answer.daemon).toBe(first.daemon)
    expect((await relay(target(ctx), { data, node, send: 1, answer: 0 }, { signal })).daemon).toBe(first.daemon)
  })

  it('preserves the name, message and code of errors from the function and from host handlers', async () => {
    const ctx = await boot(serve)
    const signal = new AbortController().signal
    const missing = runOnce(ctx.environments, target(ctx), async (path: string, env) => await env.fs.readFile(path), '/nonexistent/dsh-environment', {
      signal, result: z.unknown(),
    })
    await expect(missing).rejects.toMatchObject({
      name: 'EnvironmentError', code: 'ENVIRONMENT_RUN_FAILED', message: expect.stringContaining('ENOENT') as string,
      remote: { name: 'Error', code: 'ENOENT', message: expect.stringContaining('/nonexistent/dsh-environment') as string },
    })
    await expect(runOnce(ctx.environments, target(ctx), async (_args: null, env) => {
      try {
        return await env.origin.deny()
      } catch (error) {
        const { name, message, code } = error as Error & { code?: string }
        return { name, message, code }
      }
    }, null, {
      signal, result: z.unknown(), handlers: { deny: () => { throw new HarnessError('denied by the host', 'HOST_DENIED') } },
    })).resolves.toEqual({ name: 'HarnessError', message: 'denied by the host', code: 'HOST_DENIED' })
  })

  it('rejects functions in arguments and results at run time', async () => {
    const ctx = await boot(serve)
    const signal = new AbortController().signal
    const argument = runOnce(ctx.environments, target(ctx), (args: { callback: () => number }) => typeof args.callback, {
      callback: () => 1,
    }, { signal, result: z.string() })
    await expect(argument).rejects.toEqual(withCode('ENVIRONMENT_REQUEST_REFUSED'))
    await expect(argument).rejects.toThrow('Execution environment cannot send a value that structured clone does not support: () => 1 could not be cloned.')
    const result = runOnce(ctx.environments, target(ctx), () => ({ callback: () => 2 }), null, { signal, result: z.unknown() })
    await expect(result).rejects.toEqual(withCode('ENVIRONMENT_RUN_FAILED'))
    await expect(result).rejects.toHaveProperty('remote.message', 'Execution environment cannot send a value that structured clone does not support: () => 2 could not be cloned.')
  })

  it('shares one opening connection between concurrent runs', async () => {
    const ctx = await boot(serve)
    const signal = new AbortController().signal
    const runs = [1, 2, 3].map(value => runOnce(ctx.environments, target(ctx), (n: number) => n * 2, value, { signal, result: z.number() }))
    await expect(Promise.all(runs)).resolves.toEqual([2, 4, 6])
  })

  it('admits provider handles and rejects invalid connection limits', async () => {
    const ctx = await boot(serve)
    expect(ctx.environments.handle('ssh-this.is.a.hostname')).toBe('ssh-this.is.a.hostname')
    expect(() => ctx.environments.handle('')).toThrow()
    const owners: Context[] = []
    /** A registry in a context of its own, where no other registry holds the service name. */
    const registry = (config: Config): EnvironmentRegistry => {
      const owner = new Context()
      owners.push(owner)
      return new EnvironmentRegistry(owner, config)
    }
    const valid = { maxFrameBytes: 1024, maxMessageBytes: 1024, maxPending: 1, cancelGraceMs: 1, killGraceMs: 1, connectTimeoutMs: 1000 }
    expect(registry(valid).limits).toEqual({ maxMessageBytes: 1024 })
    for (const [invalid, field] of [[{ maxFrameBytes: 0 }, 'maxFrameBytes'], [{ maxFrameBytes: 1023 }, 'maxFrameBytes'], [{ maxMessageBytes: 1023 }, 'maxMessageBytes']] as const) {
      expect(() => registry({ ...valid, ...invalid })).toThrow(`"${field}"`)
    }
    expect(() => registry({ ...valid, maxFrameBytes: 2048 })).toThrow('maxFrameBytes must not exceed maxMessageBytes')
    const { maxMessageBytes: _omitted, ...withoutMessageLimit } = valid
    // @ts-expect-error -- the message limit is a required field of the validated configuration.
    expect(() => registry(withoutMessageLimit)).toThrow('"maxMessageBytes"')
    for (const owner of owners) await owner.fiber.dispose()
  })
})
