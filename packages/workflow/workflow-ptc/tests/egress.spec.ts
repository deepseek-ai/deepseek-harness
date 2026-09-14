import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import PtcWorkflowEngine from '../src/index.ts'
import { fakeParent, mountPtcRuntime } from './setup.ts'

describe('workflow program environment', () => {
  it('does not expose ambient credentials, proxy settings or host loader paths', async () => {
    const ctx = new Context()
    await mountPtcRuntime(ctx)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'stub',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: () => Promise.reject(new Error('environment script must not start a child')),
    })
    await ctx.plugin(PtcWorkflowEngine, { provider: 'stub' })
    const disposeProxy = await installProxyFromEnvironment({
      get: name => name === 'HTTP_PROXY' || name === 'HTTPS_PROXY'
        ? { value: 'http://fixture:canary@proxy.example:8080' } : undefined,
    }, () => undefined)
    vi.stubEnv('WORKFLOW_ENV_CANARY', 'must-not-inherit')
    vi.stubEnv('TSX_TSCONFIG_PATH', '/fixture/tsconfig.json')
    try {
      const run = ctx.workflowEngine.start({
        script: "return { ...globalThis.constructor.constructor('return process')().env }",
        meta: { name: 'environment', description: 'program environment' },
        parent: fakeParent(ctx),
      })
      try {
        const result = await run.result
        expect(result.stopReason).toBe('completed')
        expect(result.value).toEqual({})
      } finally { await run.dispose() }
    } finally {
      vi.unstubAllEnvs()
      await disposeProxy()
    }
  })
})
