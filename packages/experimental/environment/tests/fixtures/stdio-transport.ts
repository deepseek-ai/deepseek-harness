/** Test transport: runs a command whose standard input and output carry the protocol, such as `daemon-entry.ts serve --stdio`. */

import { EnvironmentHandle } from '../../src/handle.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { EnvironmentOpenContext, EnvironmentTransport } from '../../src/index.ts'

export const name = 'test-stdio-transport'
export const inject = ['environments', 'subprocess']

export interface Config {
  readonly environment: string
  readonly command: [string, ...string[]]
  readonly cwd: string
  /** Records each open's confirmation callback for assertions. */
  readonly opens?: EnvironmentOpenContext[]
}

export function apply(ctx: Context, config: Config): void {
  const transport: EnvironmentTransport = {
    async open(context) {
      config.opens?.push(context)
      const [program, ...args] = config.command
      const executable = await ctx.subprocess.resolveExecutable(program, undefined, context.signal)
      const handle = ctx.subprocess.spawn({
        argv: [executable, ...args], cwd: config.cwd, graceMs: 2000,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 4096 } },
      })
      const stderr = (): string => {
        const text = handle.collected.stderr?.readFrom(0).text.trim() ?? ''
        return text === '' ? '' : `: ${text}`
      }
      const ended = handle.done.then(
        outcome => new Error(`daemon exited with ${outcome.signal ?? `code ${outcome.exitCode}`}${stderr()}`),
        (error: unknown) => new Error(`daemon failed: ${(error as Error).message}${stderr()}`),
      )
      return { input: handle.stdout!, output: handle.stdin!, security: { kind: 'authenticated-transport' }, ended, close: () => { handle.terminate() } }
    },
  }
  ctx.effect(() => ctx.environments.register({ handle: EnvironmentHandle(config.environment), displayName: config.environment }, transport), 'test-stdio-transport')
}
