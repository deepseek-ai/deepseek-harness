/** Local subprocess fixture with private Git configuration, without mutating process.env. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { Harness } from './harness.ts'

/** Mount rg's real process provider with a per-test home for native global ignore rules. */
export async function mountSearchSubprocess(harness: Harness): Promise<string> {
  const home = join(harness.outside, 'home')
  await mkdir(home)
  await harness.ctx.plugin(LocalSubprocessRuntime)
  const spawn = harness.ctx.subprocess.spawn.bind(harness.ctx.subprocess)
  harness.ctx.subprocess.spawn = spec => spawn({
    ...spec,
    env: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, ...spec.env },
  })
  return home
}
