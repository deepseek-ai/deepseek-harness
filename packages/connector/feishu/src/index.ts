/**
 * Feishu plugin: puts the managed lark-cli on the private Shell PATH and
 * registers its embedded skills. Setup and sign-in use the CLI's default
 * account through ordinary Shell commands.
 * @module @deepseek-ai/dsh-feishu
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { FeishuCli, resolveCliDirectory, type FeishuCliLimits } from './cli.ts'
import { FeishuSkillProvider } from './skills.ts'

export const name = 'feishu'
export const inject = ['skills', 'subprocess', 'shellEnv']

/** CLI location and limits for backend skill commands. */
export interface Config extends FeishuCliLimits {
  /** Absolute directory containing `lark-cli`; defaults to the installed `@larksuite/cli` package. */
  binDir?: string
}

/** Runtime configuration schema for the Feishu plugin. */
export const Config: z<Config> = z.object({
  binDir: z.string().min(1),
  commandTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  maxOutputBytes: z.number().min(1).step(1).default(1_048_576),
})

/**
 * Register the private CLI directory and embedded skills; disposal waits for owned CLI processes.
 * @param ctx - Context carrying the skill registry, subprocess runtime, and Shell environment.
 * @param config - CLI location and command limits.
 * @throws when the subprocess runtime does not run on this Host or `lark-cli` is not executable.
 */
export function apply(ctx: Context, config: Config): void {
  if (!ctx.subprocess.runsOnHost) {
    throw new Error('feishu: lark-cli and its default account are local to this Host; mount a Host subprocess runtime')
  }
  const directory = resolveCliDirectory(config.binDir)
  ctx.shellEnv.registerPath({ name: 'feishu', directories: [directory] })
  const cli = new FeishuCli(ctx.subprocess, ctx.shellEnv, config)
  ctx.effect(() => () => cli.dispose())
  ctx.skills.registerProvider(control => new FeishuSkillProvider(cli, control, ctx.logger))
}
