/** Mount explicit OAR provider and tool rows over the production headless composition. */

import { fileURLToPath } from 'node:url'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-tools'
import { bootProductionProfile } from '../../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

let starts = 0
const ctx = await bootProductionProfile({
  binName: 'subagent-oar-loader',
  profile: 'headless',
  overlayPaths: [
    fileURLToPath(new URL('./composition.patch.yml', import.meta.url)),
  ],
  prepare: (host) => {
    host.on('subagent/start', () => { starts += 1 })
  },
})

try {
  const providers = ['oar-codex', 'oar-claude'].map((name) => {
    const provider = ctx.subagents.getProvider(name)
    if (provider === undefined) throw new Error(`Missing provider: ${name}`)
    return { name, capabilities: provider.capabilities, inheritsParentContext: provider.inheritsParentContext }
  })
  const tools = ctx.tools.schemas()
    .filter(tool => tool.name === 'subagent_oar')
    .map(tool => ({ name: tool.name, required: tool.parameters.required }))
    .sort((left, right) => left.name.localeCompare(right.name))
  process.stdout.write(`${JSON.stringify({ providers, tools, starts })}\n`)
} finally {
  await ctx.fiber.dispose()
}
