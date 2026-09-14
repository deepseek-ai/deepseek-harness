/** Exact recorded shell-command path translation; execution and reported outcomes remain real. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-shell'

export const name = 'snapshot-shell-path'
export const inject = ['shell']

/** One recorded command and its isolated live filesystem target. */
export interface Config {
  command: string
  recordedPath: string
  livePath: string
}

/**
 * Translate one exact fixture command after tool logging and approval.
 * @param ctx - profile context with its real shell executor.
 * @param config - recorded command/path and allocated live target.
 */
export function apply(ctx: Context, config: Config): void {
  const shell = ctx.shell
  // oxlint-disable-next-line typescript/unbound-method -- preserve method identity for restoration; calls bind the receiver.
  const run = shell.run
  ctx.effect(() => {
    shell.run = spec => run.call(shell, spec.command === config.command
      ? { ...spec, command: spec.command.replaceAll(config.recordedPath, "'" + config.livePath.replaceAll("'", "'\"'\"'") + "'") }
      : spec)
    return () => { shell.run = run }
  })
}
