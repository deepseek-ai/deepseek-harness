/** Local provider: contributes a managed Node execution process to the shared registry. */
import { fileURLToPath } from 'node:url'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { EnvironmentTransport } from '@deepseek-ai/dsh-environment'
import type {} from '@deepseek-ai/dsh-subprocess'

/** Cordis plugin name. */
export const name = 'environment-local'
/** Services owning environment registrations and child processes. */
export const inject = ['environments', 'subprocess']

/** One local execution environment. */
export interface Config {
  /** Stable provider-owned registry key. */
  handle: string
  /** Name shown to users. */
  displayName: string
  /** Absolute working directory of the execution process. */
  cwd: string
  /** Node executable used to start the execution process. */
  node: string
  /** Daemon entry; omission uses the installed environment package's bundle. */
  daemon?: string
  /** Additional daemon termination grace after allowing its exec process groups their negotiated grace. */
  killGraceMs: number
  /** Retained bytes of daemon standard error. */
  maxStderrBytes: number
}

/** Loader configuration and defaults. */
export const Config: schema<Config> = schema.object({
  handle: schema.string().default('local'),
  displayName: schema.string().default('Local'),
  cwd: schema.string().required(),
  node: schema.string().default(process.execPath),
  daemon: schema.string(),
  killGraceMs: schema.natural().min(1).default(2000),
  maxStderrBytes: schema.natural().min(1).default(65536),
})
const configSchema = z.object({
  handle: z.string().min(1), displayName: z.string().min(1),
  cwd: z.string().refine(isAbsolute, 'cwd must be absolute'), node: z.string().min(1),
  daemon: z.string().refine(isAbsolute, 'daemon must be absolute').optional(),
  killGraceMs: z.number().int().positive(), maxStderrBytes: z.number().int().positive(),
}).strict()

/**
 * Contribute a local environment; its execution process starts on first use.
 * @param ctx - registry and subprocess owner.
 * @param config - identity, process location and output bounds.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = configSchema.parse(config)
  const daemon = resolved.daemon ?? fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-environment/daemon.js'))
  const transport: EnvironmentTransport = {
    async open(context) {
      const executable = await ctx.subprocess.resolveExecutable(resolved.node, undefined, context.signal)
      context.signal.throwIfAborted()
      const graceMs = context.killGraceMs + resolved.killGraceMs
      if (!Number.isSafeInteger(graceMs) || graceMs > 2_147_483_647) {
        throw new RangeError('environment-local: combined exec and daemon termination grace exceeds the Node timer limit')
      }
      const child = ctx.subprocess.spawn({
        argv: [executable, daemon, 'serve', '--stdio'], cwd: resolved.cwd, graceMs,
        env: { ELECTRON_RUN_AS_NODE: '1' },
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: resolved.maxStderrBytes } },
      })
      /* v8 ignore next 4 -- pipe dispositions guarantee both streams in every subprocess provider. */
      if (child.stdout === undefined || child.stdin === undefined) {
        child.terminate()
        throw new Error('environment-local: subprocess provider dropped a piped stream')
      }
      /* v8 ignore next -- the collect disposition guarantees a stderr reader. */
      const detail = (): string => child.collected.stderr?.readFrom(0).text.trim() ?? ''
      const ended = child.done.then(
        outcome => new Error(`Local environment exited with ${outcome.signal ?? `code ${outcome.exitCode}`}: ${detail()}`),
        (error: unknown) => new Error(`Local environment failed: ${(error as Error).message}: ${detail()}`),
      )
      return {
        input: child.stdout, output: child.stdin, security: { kind: 'authenticated-transport' }, ended,
        close: () => { child.terminate() },
      }
    },
  }
  ctx.effect(() => ctx.environments.register({
    handle: ctx.environments.handle(resolved.handle), displayName: resolved.displayName,
  }, transport), 'environment-local.registration')
}
