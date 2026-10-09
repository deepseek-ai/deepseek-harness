/** Shared observation and result fields for successful file mutations. */

import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/**
 * Record the new file version and expose the mutation result with its canonical path.
 * @param ctx - filesystem and observation event owner.
 * @param target - resolved file that was mutated.
 * @param outcome - successful provider result; its version stays in the observation event.
 * @param exec - calling tool execution.
 * @returns the provider's result fields without the version, plus the canonical absolute path.
 */
export function mutationResult<T extends { version: FsVersion }>(
  ctx: Context, target: FsTarget, outcome: T, exec: ToolExecution,
): Omit<T, 'version'> & { path: string } {
  const { version, ...result } = outcome
  ctx.emit('fs/observed', target, { kind: 'present', version }, exec)
  return { path: ctx.fs.processPath(target), ...result }
}
