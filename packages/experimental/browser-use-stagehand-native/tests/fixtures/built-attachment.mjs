/** Plain-Node smoke of the published provider and its independently configured attachment Worker. */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import BrowserUseRegistry from '@deepseek-ai/dsh-browser-use'
import { brandString } from '@deepseek-ai/dsh-brand'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as Provider from '../../lib/index.js'

/** @type {(value: string) => import('@deepseek-ai/dsh-llm').ToolCallId} */
const toolCallId = brandString
/** @type {(value: string) => import('@deepseek-ai/dsh-session/types').SessionId} */
const sessionId = brandString

const [endpoint, url] = process.argv.slice(2)
if (endpoint === '--check-imports') {
  process.stdout.write(sessionId('built-stagehand') + '\n')
} else {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(BrowserUseRegistry)
    const provider = ctx.plugin(Provider, {
      mode: 'attach', cdpEndpoint: endpoint,
      model: { modelName: 'openai/gpt-5.4-mini', apiKey: 'offline-browser-smoke' },
    })
    await provider
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(sessionId('built-stagehand'))
    const call = async (method, args) => {
      const result = await executeModelToolFixture(ctx, { agent, name: `stagehand_${method}`, arguments: args, callId: toolCallId(`built-${method}`), signal: new AbortController().signal })
      if (result.isError) throw new Error(JSON.stringify(result.content))
      return result
    }
    await call('tabs', { action: 'new', url })
    const result = await call('navigate', { url })
    await provider.dispose()
    process.stdout.write(JSON.stringify({ result: result.content }) + '\n')
  } finally {
    await ctx.fiber.dispose()
  }
}
