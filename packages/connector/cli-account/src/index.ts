/**
 * Shared Host mechanism of CLI app plugins: run a third-party CLI that owns the user's account on the private Shell PATH,
 * and run one account operation at a time for the Plugins page. Each plugin keeps its own commands, parsing, and states.
 * @module @deepseek-ai/dsh-cli-account
 */

import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

export { CliCommandExecutor, type CliCommandExecutorOptions, type CliCommandResult, type CliRunOptions } from './executor.ts'
export { CliAccountRuntime, exitFailure, type CliAccountRuntimeOptions, type CliOperationControl } from './runtime.ts'
export type * from './types.ts'

/** Where a plugin's CLI is and how long commands that do not wait for the user may run. */
export interface CliAccountConfig {
  /** Absolute directory holding the CLI executable; the plugin defines the default. */
  binDir?: string
  /** Deadline in milliseconds for a command that does not wait for the user, including executable lookup. */
  commandTimeoutMs: number
}

/** Schema for {@link CliAccountConfig}; a plugin with no other fields uses it as its `Config`. */
export const CliAccountConfig: z<Partial<CliAccountConfig>, CliAccountConfig> = z.object({
  binDir: z.string().min(1),
  commandTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
})
