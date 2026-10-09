/** Exercise user-global instruction reconciliation during a provider metadata outage. */

import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'workspace-context-global-failure'
export const inject = ['fs']

/**
 * Change the harness-home file while its duplicate is unavailable, then restore observation.
 * @param ctx - scenario context with its real filesystem provider.
 */
export function apply(ctx: Context): void {
  let unavailablePath: string | undefined
  ctx.effect(() => {
    const fileSystem = ctx.fs
    const originalStat = fileSystem.stat.bind(fileSystem)
    const originalDescriptor = Object.getOwnPropertyDescriptor(fileSystem, 'stat')
    fileSystem.stat = async (target, signal) => {
      signal?.throwIfAborted()
      if (fileSystem.processPath(target) === unavailablePath) throw new Error('Shared instructions are temporarily unavailable')
      return originalStat(target, signal)
    }
    return () => {
      if (originalDescriptor === undefined) Reflect.deleteProperty(fileSystem, 'stat')
      else Object.defineProperty(fileSystem, 'stat', originalDescriptor)
    }
  }, 'snapshot.userGlobalMetadataFailure')

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (result.isError
      || downstream.kind !== 'accept'
      || exec.agent === undefined
      || exec.name !== 'read'
      || typeof exec.arguments !== 'object'
      || exec.arguments === null
      || !('file_path' in exec.arguments)) return downstream
    const cwd = exec.agent.session.header.cwd
    if (cwd === undefined) throw new Error('Global instruction snapshot requires a session cwd')
    const homeFile = join(cwd, '.dsh', 'AGENTS.md')
    const sharedFile = join(cwd, '.agents', 'AGENTS.md')
    switch (exec.arguments.file_path) {
      case 'first.txt':
        await writeFile(homeFile, 'Updated global instruction B.\n')
        unavailablePath = sharedFile
        break
      case 'second.txt':
        assert.equal(await readFile(homeFile, 'utf8'), 'Updated global instruction B.\n')
        assert.equal(await readFile(sharedFile, 'utf8'), 'Original global instruction A.\n')
        unavailablePath = undefined
        break
    }
    return downstream
  })
}
