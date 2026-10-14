/**
 * Shared Host mechanism of CLI app plugins: run a third-party CLI that owns the user's account on the private Shell PATH,
 * and run one account operation at a time for the Plugins page. Each plugin keeps its own commands, parsing, and states.
 * @module @deepseek-ai/dsh-cli-account
 */

export { CliAccountConfig } from './config.ts'
export { CliCommandExecutor, type CliCommandExecutorOptions, type CliCommandResult, type CliRunOptions } from './executor.ts'
export { CliAccountRuntime, exitFailure, type CliAccountRuntimeOptions, type CliOperationControl } from './runtime.ts'
export type * from './types.ts'
