/** Cancel after the PTC process completes a nested job_list call. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'ptc-cancel-fixture'
export const inject = ['tools']
export function apply(ctx) {
  ctx.on('agent/turn-finalizing', async ({ agent }) => {
    await Promise.resolve()
    agent.inject(createUserMessage({ content: [{ type: 'text', text: 'Turn resources released.' }], source: { kind: 'user' } }))
  })
  ctx.on('tools/result', (exec) => {
    if (exec.name === 'job_list' && exec.parent !== undefined && exec.agent !== undefined) {
      exec.agent.cancel({ kind: 'user' })
    }
  })
}
