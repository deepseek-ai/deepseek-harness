/** Native permission switching and its next-request context through the SDK. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import ShellExecutor from '@deepseek-ai/dsh-shell'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { expect, it } from 'vitest'
import { HarnessSdkJsonRpcServer } from '../src/server.ts'

/** The model never executes tools; only the shell's declared confinement is needed. */
class UnusedShell extends ShellExecutor {
  static inject = ['sandboxPolicy']

  override get sandboxMode() { return this.ctx.sandboxPolicy.defaultMode }
  override resolve(): never { throw new Error('The permission model does not execute shell commands') }
  override execute(): never { throw new Error('The permission model does not execute shell commands') }
}

function modelInput(options: GenerateOptions) {
  return structuredClone({
    provider: options.provider,
    model: options.model,
    system: options.system,
    messages: options.messages.map(message => ({ role: message.role, content: message.content })),
    tools: options.tools,
    toolHistory: options.toolHistory,
    maxTokens: options.maxTokens,
    reasoningEffort: options.reasoningEffort,
    temperature: options.temperature,
    stop: options.stop,
    purpose: options.purpose,
  })
}

class PermissionModel extends LlmAdapter {
  readonly requests: ReturnType<typeof modelInput>[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(modelInput(options))
    const text = this.requests.length === 1 ? 'PERMISSION_READY' : 'PERMISSION_CONTINUED'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function switchAndContinue(path: 'sdk' | 'native', cwd: string) {
  const ctx = new Context()
  let server: HarnessSdkJsonRpcServer | undefined
  const sessionId = SessionId('permission-parity')
  const events: SessionEvent[] = []
  try {
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: cwd })
    await ctx.plugin(UnusedShell)
    await ctx.plugin(ApprovalService, { policy: 'never' })
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(PermissionPresetService, {
      presets: {
        'read-only': { sandbox: 'read-only', approval: 'ask' },
        'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
        'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
      },
    })
    ctx.on('session/event', (session, event) => {
      if (session.id === sessionId) events.push(event)
    })
    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'read_marker',
      description: 'Read a workspace marker.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => Promise.reject(new Error('The permission model does not execute tools')),
    })))
    const model = new PermissionModel()
    ctx.effect(() => ctx.llm.registerAdapter(['permission-parity'], model))
    server = new HarnessSdkJsonRpcServer(ctx, {
      request: async () => { throw new Error('The permission model does not request approval') },
      notify: () => {},
    })
    const runtime = server
    const initialConfig = { cwd, provider: 'permission-parity', model: 'permission-model', maxTokens: 321 }
    await server.initialize(initialConfig)
    await server.prompt({ sessionId, contentBlocks: [{ type: 'text', text: 'Keep the original task in context.' }] })
    await server.wait({ sessionId })
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('The initial prompt did not create its Agent')
    const dispatch = async (line: string) => {
      if (path === 'native') return ctx.commands.execute(agent, line, [], new AbortController().signal)
      const routed = await runtime.query({ sessionId, contentBlocks: [{ type: 'text', text: line }] })
      if (routed.kind !== 'command') throw new Error('The explicit permission input was submitted as a prompt')
      return routed.execution
    }
    const beforeSwitch = events.length
    const changed = await dispatch('/permission read-only')
    expect(changed?.result).toEqual({ kind: 'success', text: 'preset read-only' })
    const switchEvents = events.slice(beforeSwitch)
    expect(switchEvents.map(event => event.type)).toEqual([
      'command/run', 'permission/preset', 'sandbox/mode', 'approval/policy', 'agent/inbox/spliced', 'command/done',
    ])
    const beforeNoop = events.length
    const unchanged = await dispatch('/permission read-only')
    expect(unchanged?.result).toEqual(changed?.result)
    expect(events.slice(beforeNoop).map(event => event.type)).toEqual(['command/run', 'command/done'])
    const beforeInvalid = events.length
    const invalid = await dispatch('/permission missing-preset')
    expect(invalid?.result).toEqual({
      kind: 'error', text: 'unknown preset "missing-preset" (available: read-only, workspace-write, danger-full-access)',
    })
    expect(events.slice(beforeInvalid).map(event => event.type)).toEqual(['command/run', 'command/done'])
    expect(model.requests).toHaveLength(1)
    expect(ctx.permissionPresets.current(agent.session)).toBe('read-only')
    expect(ctx.sandboxPolicy.resolve({ session: agent.session }).mode).toBe('read-only')
    expect(switchEvents.find(event => event.type === 'approval/policy')?.data).toEqual({ policy: 'ask' })

    await server.prompt({ sessionId, contentBlocks: [{ type: 'text', text: 'Continue the original task without tools.' }] })
    await server.wait({ sessionId })
    await server.getWorkingDirectory({ sessionId: 'permission-fresh' })
    const fresh = ctx.agents.get(SessionId('permission-fresh'))
    if (fresh === undefined) throw new Error('The second Session was not created')
    expect(ctx.permissionPresets.current(fresh.session)).toBe('danger-full-access')
    const defaults = {
      preset: ctx.permissionPresets.defaultPreset,
      sandbox: ctx.sandboxPolicy.defaultMode,
      approval: ctx.approval.config.policy,
    }
    expect(defaults).toEqual({ preset: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' })
    expect(initialConfig).toEqual({ cwd, provider: 'permission-parity', model: 'permission-model', maxTokens: 321 })
    return {
      requests: model.requests,
      approvalInputs: events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user-approval'
        ? [event.data.content] : []),
      defaults,
      permissionEvents: events.flatMap((event) => {
        if (event.type === 'permission/preset' || event.type === 'sandbox/mode' || event.type === 'approval/policy') {
          return [{ type: event.type, data: event.data }]
        }
        return []
      }),
      turns: events.flatMap(event => event.type === 'turn/start' ? [event.data.turn] : []),
      steps: events.flatMap(event => event.type === 'step/start' ? [{ turn: event.data.turn, step: event.data.step }] : []),
    }
  } finally {
    try { await server?.shutdown() } finally { await ctx.fiber.dispose() }
  }
}

it('preserves native permission events, unchanged defaults, and the next model request through query', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-sdk-permission-parity-'))
  try {
    const native = await switchAndContinue('native', cwd)
    const sdk = await switchAndContinue('sdk', cwd)
    expect(sdk).toEqual(native)
    expect(sdk.requests).toHaveLength(2)
    expect(sdk.turns).toEqual([1, 2])
    expect(sdk.steps).toEqual([{ turn: 1, step: 1 }, { turn: 2, step: 1 }])
    expect(sdk.requests.map(request => request.maxTokens)).toEqual([321, 321])
    expect(sdk.requests[1]?.tools).toEqual(sdk.requests[0]?.tools)
    expect(sdk.requests[1]?.messages[0]).toEqual(sdk.requests[0]?.messages[0])
    const content = sdk.requests[1]?.messages.flatMap(message => message.content) ?? []
    const texts = content.flatMap(block => block.type === 'text' ? [block.text] : [])
    expect(texts).toContain('PERMISSION_READY')
    expect(sdk.approvalInputs).toHaveLength(1)
    expect(content).toEqual(expect.arrayContaining(sdk.approvalInputs.flat()))
    expect(texts.some(text => text.includes('Current DSH file policy: read-only.'))).toBe(true)
    expect(texts).not.toContain('/permission read-only')
    expect(texts).not.toContain('preset read-only')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
