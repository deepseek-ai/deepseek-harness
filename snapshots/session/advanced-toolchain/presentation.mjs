/** Select PTC for the parent program, then restore native calls before child creation. */
import { NativeToolRegistry } from '@deepseek-ai/dsh-tool-registry-native'
import { PtcToolRegistry } from '@deepseek-ai/dsh-tool-registry-ptc'

export const name = 'advanced-toolchain-presentation'
export const inject = ['tools']

export function apply(ctx) {
  const unmounts = new WeakMap()
  ctx.on('tools/result', (exec, result) => {
    if (exec.agent === undefined || exec.parent !== undefined || result.error !== undefined) return
    const agent = exec.agent
    if (exec.name === 'cordis_inspect' && !unmounts.has(agent)) {
      // `run_code` is the reserved entry name; built profiles do not resolve dsh-tools from scenario fixtures.
      unmounts.set(agent, new PtcToolRegistry(agent.ctx, { name: 'run_code' }).mountRoot())
    } else if (exec.name === 'run_code') {
      unmounts.get(agent)?.()
      unmounts.set(agent, null)
      const native = new NativeToolRegistry()
      agent.ctx.tools.setRoot(native)
    }
  })
}
