import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as HooksCodex from '@deepseek-ai/dsh-hooks-codex'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const testToolSignal = new AbortController().signal

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function dir(): string { const d = mkdtempSync(join(tmpdir(), 'dsh-hx-cov-')); dirs.push(d); return d }
function sh(d: string, name: string, body: string): string {
  const p = join(d, name); writeFileSync(p, body); chmodSync(p, 0o755); return p
}
function hooks(d: string, h: unknown): string {
  writeFileSync(join(d, 'hooks.json'), JSON.stringify({ hooks: h })); return join(d, 'hooks.json')
}

type HarnessOpts = { stderrSummaryMaxChars?: number; sessionRoot?: string }
async function harness(configPath: string, adapter: MockAdapter, opts: HarnessOpts = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  if (opts.sessionRoot !== undefined) await ctx.plugin(JsonlSessionPersistence, { root: opts.sessionRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  await ctx.plugin(HooksCodex, { configPath, model: 'm', ...opts })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}
function waitForIdle(_ctx: Context, agent: Agent): Promise<void> {
  return agent.whenIdle()
}
function events(agent: Agent): readonly SessionEvent[] { return agent.session.snapshotEvents() }
/** Poll until `predicate` holds or the deadline passes — robust to detached
 * emit-listener hooks firing on a `.then` (a fixed sleep flakes under load). */
async function waitFor(predicate: () => boolean, timeout = 5000, interval = 10): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met before deadline')
    await new Promise(r => setTimeout(r, interval))
  }
}

export type CoverageGroup = 'prompt' | 'post-tool' | 'result-shape' | 'edge-paths' | 'payload'

/** Register independently schedulable slices of the hooks-codex coverage matrix. */
export function defineCoverageCases(groups: CoverageGroup | readonly CoverageGroup[]): void {
  const selected = new Set(typeof groups === 'string' ? [groups] : groups)
  if (selected.has('prompt')) describe('hooks-codex coverage — prompt decision mapping', () => {
    it('degrades transcript_path to null even with persistence mounted', async () => {
      const d = dir()
      const cap = join(d, 'payload')
      const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'capture.sh', `#!/usr/bin/env bash\ncat > "${cap}"\n`) }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
      const ctx = await harness(path, adapter, { sessionRoot: dir() })
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('transcript'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      // The persistence seam exposes no artifact paths, so the field stays null
      // even with a persistence backend mounted.
      expect((JSON.parse(readFileSync(cap, 'utf8')) as { transcript_path: string | null }).transcript_path).toBeNull()
    }, 15_000) // The real agent/hook subprocess loop needs process startup and teardown headroom.

    it('UserPromptSubmit block (exit 2) closes a blocked turn without a step', async () => {
      const d = dir()
      hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: sh(d, 'b.sh', '#!/usr/bin/env bash\nexit 2\n') }] }] })
      const adapter = new MockAdapter([textResponse('no')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      expect(adapter.requests).toHaveLength(0)
      expect(events(agent).filter(e => e.type === 'turn/start' || e.type === 'hook/invoked'
        || e.type === 'hook/result' || e.type === 'turn/end').map(e => e.type))
        .toEqual(['turn/start', 'hook/invoked', 'hook/result', 'turn/end'])
    })

    it('UserPromptSubmit additionalContext is injected; a no-op hook proceeds', async () => {
      const d = dir()
      hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: sh(d, 'c.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"ctx-x"}}\'\n') }] }] })
      const adapter = new MockAdapter([textResponse('ok')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('ctx-x')
    })

    it('a context-only UserPromptSubmit hook DELEGATES so a later listener can still block', async () => {
    // Context alone is not a veto: the bridge delegates with `next()` and folds its context, so a
    // downstream policy listener can still block.
      const d = dir()
      hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: sh(d, 'c.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"bridge ctx"}}\'\n') }] }] })
      const adapter = new MockAdapter([textResponse('should not run')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      ctx.on('agent/pre-step', async () => ({
        kind: 'reject' as const,
      }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      expect(adapter.requests).toHaveLength(0)
      expect(events(agent).some(e => e.type === 'user/message')).toBe(false)
      expect(events(agent).filter(e => e.type === 'turn/start' || e.type === 'hook/invoked'
        || e.type === 'hook/result' || e.type === 'turn/end').map(e => e.type))
        .toEqual(['turn/start', 'hook/invoked', 'hook/result', 'turn/end'])
    })

    it('preserves separate bridge and downstream prompt contexts with framing and metadata', async () => {
      const d = dir()
      hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: sh(d, 'c.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"from-bridge"}}\'\n') }] }] })
      const adapter = new MockAdapter([textResponse('ok')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      ctx.on('agent/pre-step', async ({ messages }) => ({
        kind: 'enter' as const,
        messages: [{
          ...messages[0]!,
          content: [{ type: 'text' as const, text: 'rewritten-prompt' }],
        }, createUserMessage({
          content: [{ type: 'text' as const, text: 'from-downstream' }],
          source: { kind: 'plugin' as const, plugin: 'policy' },
        })],
      }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      const req = JSON.stringify(adapter.requests[0]!.messages)
      expect(req).toContain('from-bridge')
      expect(req).toContain('from-downstream')
      expect(req).toContain('rewritten-prompt')
      const contexts = events(agent).filter(event => event.type === 'user/message' && event.data.source.kind !== 'user')
      expect(contexts.map(event => event.type === 'user/message' && event.data.source)).toEqual([
        { kind: 'plugin', plugin: 'policy' },
        { kind: 'plugin', plugin: 'hooks-codex' },
      ])
    })
  })

  if (selected.has('post-tool')) describe('hooks-codex coverage — post-tool and session context mapping', () => {
    it('folds the bridge PostToolUse context onto a downstream canonical value replacement', async () => {
      const d = dir()
      hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'pc.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"bridge-note"}}\'\n') }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      ctx.on('tools/post-execute', async () => ({ kind: 'accept' as const, value: [{ type: 'text' as const, text: 'rewritten-result' }] }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      const result = events(agent).find(e => e.type === 'tool/result')
      expect(result?.type === 'tool/result' && result.data.message.content[0].content.some(b => b.type === 'text' && b.text === 'rewritten-result')).toBe(true)
      expect(events(agent).some(e => e.type === 'user/message' && e.data.source.kind !== 'user' && e.data.content.some(b => b.type === 'text' && b.text.includes('bridge-note')))).toBe(true)
    })

    it('keeps bridge and downstream PostToolUse contexts as separate sourced events', async () => {
      const d = dir()
      hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'pc.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"bridge-note"}}\'\n') }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      ctx.on('tools/post-execute', async () => ({
        kind: 'accept' as const,
        additionalContexts: [createUserMessage({
          content: [{ type: 'text' as const, text: 'downstream-note' }],
          source: { kind: 'plugin' as const, plugin: 'policy' },
        })],
      }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)

      const contexts = events(agent).filter(event => event.type === 'user/message' && event.data.source.kind !== 'user')
      expect(contexts.map(event => event.type === 'user/message' && event.data.source)).toEqual([
        { kind: 'plugin', plugin: 'hooks-codex' },
        { kind: 'plugin', plugin: 'policy' },
      ])
    })

    it('folds the bridge PostToolUse context onto a downstream listener BLOCK', async () => {
      const d = dir()
      hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'pc.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"bridge-note"}}\'\n') }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      ctx.on('tools/post-execute', async () => ({ kind: 'block' as const, feedback: [{ type: 'text' as const, text: 'downstream-block' }] }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      const result = events(agent).find(e => e.type === 'tool/result')
      expect(result?.type === 'tool/result' && result.data.message.content[0].isError).toBe(true)
      expect(result?.type === 'tool/result' && result.data.message.content[0].content.some(b => b.type === 'text' && b.text.includes('downstream-block'))).toBe(true)
      expect(events(agent).some(e => e.type === 'user/message' && e.data.source.kind !== 'user' && e.data.content.some(b => b.type === 'text' && b.text.includes('bridge-note')))).toBe(true)
    }, 10_000) // The real hook subprocess needs startup and teardown headroom under full-suite contention.

    it('SessionStart additionalContext is injected for the first request', async () => {
      const d = dir()
      hooks(d, { SessionStart: [{ hooks: [{ type: 'command', command: sh(d, 's.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"start-ctx"}}\'\n') }] }] })
      const adapter = new MockAdapter([textResponse('ok')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      await waitFor(() => agent.inbox.nextStep.some(message =>
        message.content.some(block => block.type === 'text' && block.text.includes('start-ctx'))))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('start-ctx')
    })

    it('PostToolUse block (exit 2) → isError feedback; default reason', async () => {
      const d = dir()
      hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'p.sh', '#!/usr/bin/env bash\nexit 2\n') }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'ls' }), textResponse('done')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      ctx.tools.register(defineContentToolFixture({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      const r = events(agent).find(e => e.type === 'tool/result')
      expect(r?.type === 'tool/result' && r.data.message.content[0].isError).toBe(true)
      expect(r?.type === 'tool/result' && r.data.message.content[0].content.some(b => b.type === 'text' && b.text.includes('blocked by PostToolUse hook'))).toBe(true)
    })

    it('PostToolUse additionalContext (clean exit) is attached after the result', async () => {
      const d = dir()
      hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'pc.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"post-ctx"}}\'\n') }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'ls' }), textResponse('done')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      ctx.tools.register(defineContentToolFixture({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      expect(events(agent).some(e => e.type === 'user/message' && e.data.source.kind !== 'user' && e.data.content.some(b => b.type === 'text' && b.text.includes('post-ctx')))).toBe(true)
    })
  })

  if (selected.has('result-shape')) describe('hooks-codex coverage — hook result shape and configuration', () => {
    it('PreToolUse for a tool call WITHOUT a command arg passes an empty command (commandOf non-object/missing arm)', async () => {
      const d = dir()
      hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'pre.sh', '#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n') }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', {}), textResponse('done')]) // no command arg
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      let ran = false
      ctx.tools.register(defineContentToolFixture({ name: 'Bash', description: 'b', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      expect(ran).toBe(true) // clean-exit hook allows; commandOf returned ''
    })

    it('a clean exit-0 hook records exitCode 0 and omits stderrSummary', async () => {
      const d = dir()
      hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'n.sh', '#!/usr/bin/env bash\nexit 0\n') }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'x' }), textResponse('done')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      ctx.tools.register(defineContentToolFixture({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      const res = events(agent).find(e => e.type === 'hook/result')
      expect(res?.type === 'hook/result' && res.data.exitCode).toBe(0)
      expect(res?.type === 'hook/result' && 'stderrSummary' in res.data).toBe(false)
    })

    it('a long stderr is truncated in the hook/result summary', async () => {
      const d = dir()
      hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'l.sh', '#!/usr/bin/env bash\nprintf "x%.0s" {1..600} >&2\nexit 2\n') }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'x' }), textResponse('done')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      ctx.tools.register(defineContentToolFixture({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      const res = events(agent).find(e => e.type === 'hook/result')
      expect(res?.type === 'hook/result' && res.data.stderrSummary?.endsWith('…')).toBe(true)
      expect(res?.type === 'hook/result' && res.data.stderrSummary?.length).toBe(501) // default 500-char cap + ellipsis
    })

    it('rejects a non-positive or fractional stderrSummaryMaxChars at load', async () => {
      const d = dir()
      hooks(d, {})
      for (const bad of [0, -5, 1.5, Number.NaN]) {
        const adapter = new MockAdapter([])
        await expect(harness(join(d, 'hooks.json'), adapter, { stderrSummaryMaxChars: bad }))
          .rejects.toThrow(/hooks-codex: stderrSummaryMaxChars must be a positive integer/)
      }
    })

    it('the stderr summary cap is plugin config (stderrSummaryMaxChars)', async () => {
      const d = dir()
      hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'l.sh', '#!/usr/bin/env bash\nprintf "x%.0s" {1..600} >&2\nexit 2\n') }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'x' }), textResponse('done')])
      const ctx = await harness(join(d, 'hooks.json'), adapter, { stderrSummaryMaxChars: 40 })
      ctx.tools.register(defineContentToolFixture({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      const res = events(agent).find(e => e.type === 'hook/result')
      expect(res?.type === 'hook/result' && res.data.stderrSummary).toBe('x'.repeat(40) + '…')
    })

    it('warns on a skipped async hook and a direct apply() (schema bypass) runs', async () => {
      const d = dir()
      const marker = join(d, 'ran')
      hooks(d, { UserPromptSubmit: [{ hooks: [
        { type: 'command', command: 'bg.sh', async: true }, // skipped → warn
        { type: 'command', command: sh(d, 'h.sh', `#!/usr/bin/env bash\ntouch "${marker}"\n`) },
      ] }] })
      const warn = vi.fn()
      const adapter = new MockAdapter([textResponse('ok')])
      const ctx = new Context()
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
      ctx.logger.warn = warn as never
      // Direct apply (schema bypass) → the `model ?? ''` fallback is exercised.
      HooksCodex.apply(ctx, { configPath: join(d, 'hooks.json') })
      ctx.llm.registerAdapter(['mock'], adapter)
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      expect(existsSync(marker)).toBe(true)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('async hook'))
    })

    it('a no-op clean hook proceeds (contextFrom empty → next)', async () => {
      const d = dir()
      hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'n.sh', '#!/usr/bin/env bash\nexit 0\n') }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'x' }), textResponse('done')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      let ran = false
      ctx.tools.register(defineContentToolFixture({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      expect(ran).toBe(true)
    })

    it('SessionStart with no additionalContext is a no-op (contextFrom empty)', async () => {
      const d = dir()
      // The hook touches a marker so we can wait for it to ACTUALLY FINISH before
      // asserting absence — a completed turn alone would not prove the detached
      // session-start hook ran, making the absence check a false pass.
      const marker = join(d, 'ss-ran')
      hooks(d, { SessionStart: [{ hooks: [{ type: 'command', command: sh(d, 's.sh', `#!/usr/bin/env bash\ntouch "${marker}"\nexit 0\n`) }] }] })
      const adapter = new MockAdapter([textResponse('ok')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      await waitFor(() => existsSync(marker)) // the clean no-output hook has finished
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      expect(events(agent).some(e => e.type === 'user/message' && e.data.source.kind !== 'user')).toBe(false)
    })

    it('a throwing SessionStart inject is contained (logged)', async () => {
      const d = dir()
      hooks(d, { SessionStart: [{ hooks: [{ type: 'command', command: sh(d, 's.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"x"}}\'\n') }] }] })
      const adapter = new MockAdapter([textResponse('ok')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      const warn = vi.fn(); ctx.logger.warn = warn as never
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.inject = (() => { throw new Error('inject boom') })
      await waitFor(() => warn.mock.calls.some(c => String(c[0]).includes('SessionStart hook failed')))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('SessionStart hook failed'))
    })
  })

  if (selected.has('edge-paths')) describe('hooks-codex coverage — matching and no-agent edge paths', () => {
    it('a clean PreToolUse with no decision allows the tool (no deny)', async () => {
      const d = dir()
      hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'ok.sh', '#!/usr/bin/env bash\nexit 0\n') }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'x' }), textResponse('done')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      let ran = false
      ctx.tools.register(defineContentToolFixture({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      expect(ran).toBe(true)
    })

    it('a non-matching regex matcher skips the hook (matchesMatcher false → continue)', async () => {
      const d = dir()
      // /^Edit$/ does not match the tool name "Bash" → the group is skipped.
      hooks(d, { PreToolUse: [{ matcher: '^Edit$', hooks: [{ type: 'command', command: sh(d, 'deny.sh', '#!/usr/bin/env bash\nexit 2\n') }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'x' }), textResponse('done')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      let ran = false
      ctx.tools.register(defineContentToolFixture({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      expect(ran).toBe(true) // matcher didn't match → no hook ran → tool proceeded
      expect(events(agent).some(e => e.type === 'hook/invoked')).toBe(false)
    })

    it('a {"continue":false} hook is RECORDED as "stop" but does not halt the run (TODO(hook-continue-false))', async () => {
    // Honoring `continue:false` is deferred — the extension points have no hard-halt
    // primitive. Assert the LOG records the halt request AND that the run is not
    // actually halted (the tool still runs, the turn completes).
      const d = dir()
      hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: sh(d, 's.sh', '#!/usr/bin/env bash\necho \'{"continue":false,"stopReason":"halt"}\'\n') }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'x' }), textResponse('done')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      let ran = false
      ctx.tools.register(defineContentToolFixture({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      const res = events(agent).find(e => e.type === 'hook/result')
      expect(res?.type === 'hook/result' && res.data.decision).toBe('stop') // recorded
      expect(ran).toBe(true) // NOT honored: the tool still ran (halt is deferred)
    })

    it('PreToolUse deny with EMPTY stderr uses the default reason (?? right arm)', async () => {
      const d = dir()
      hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'd.sh', '#!/usr/bin/env bash\nexit 2\n') }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'x' }), textResponse('done')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      ctx.tools.register(defineContentToolFixture({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      const r = events(agent).find(e => e.type === 'tool/result')
      expect(r?.type === 'tool/result' && r.data.message.content[0].content.some(b => b.type === 'text' && b.text.includes('blocked by PreToolUse hook'))).toBe(true)
    })

    it('PostToolUse block AND additionalContext are surfaced together', async () => {
      const d = dir()
      hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'bc.sh', '#!/usr/bin/env bash\necho \'{"decision":"block","reason":"bad","hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"ctx too"}}\'\n') }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'x' }), textResponse('done')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      ctx.tools.register(defineContentToolFixture({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      const r = events(agent).find(e => e.type === 'tool/result')
      expect(r?.type === 'tool/result' && r.data.message.content[0].isError).toBe(true)
      expect(r?.type === 'tool/result' && r.data.message.content[0].content.some(b => b.type === 'text' && b.text.includes('bad'))).toBe(true)
      expect(events(agent).some(e => e.type === 'user/message' && e.data.source.kind !== 'user' && e.data.content.some(b => b.type === 'text' && b.text.includes('ctx too')))).toBe(true)
    })

    it('commandOf reads a non-string command arg as an empty command', async () => {
      const d = dir()
      // The tool-call arguments carry `command` as a NUMBER → commandOf's
      // `typeof command === 'string'` false arm → '' (the payload's tool_input.command).
      const cap = join(d, 'payload')
      hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'cap.sh', `#!/usr/bin/env bash\ncat > "${cap}"\nexit 0\n`) }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 7 }), textResponse('done')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      ctx.tools.register(defineContentToolFixture({ name: 'Bash', description: 'b', parameters: { command: { type: 'number' } }, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      const payload = JSON.parse(readFileSync(cap, 'utf8')) as { tool_input: { command: string } }
      expect(payload.tool_input.command).toBe('')
    })

    it('a no-agent direct PreToolUse run uses process.cwd() and turn 0 (no session to record)', async () => {
      const d = dir()
      hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'd.sh', '#!/usr/bin/env bash\nexit 2\n') }] }] })
      const ctx = await harness(join(d, 'hooks.json'), new MockAdapter([]))
      let ran = false
      ctx.tools.register(defineContentToolFixture({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { ran = true; return [{ type: 'text', text: 'x' }] } }))
      const { ToolCallId } = await import('@deepseek-ai/dsh-llm')
      const result = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c1'), name: 'Bash', arguments: { command: 'x' } })
      expect(ran).toBe(false) // denied
      expect(result.isError).toBe(true)
    })

    it('a no-agent direct PostToolUse run attaches context with no session to record', async () => {
      const d = dir()
      hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'pc.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"x"}}\'\n') }] }] })
      const ctx = await harness(join(d, 'hooks.json'), new MockAdapter([]))
      ctx.tools.register(defineContentToolFixture({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      const { ToolCallId } = await import('@deepseek-ai/dsh-llm')
      const result = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c1'), name: 'Bash', arguments: { command: 'x' } })
      expect(result.isError).toBeFalsy()
      expect(result.additionalContexts?.[0]?.content.some(b => b.type === 'text' && b.text === 'x')).toBe(true)
    })

    it('when the bash executor REJECTS, the hook/result omits exitCode (non-blocking)', async () => {
      const d = dir()
      hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'h.sh', '#!/usr/bin/env bash\nexit 0\n') }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'x' }), textResponse('done')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      ctx.shell.run = (() => Promise.reject(new Error('executor down')))
      ctx.tools.register(defineContentToolFixture({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      const res = events(agent).find(e => e.type === 'hook/result')
      expect(res?.type === 'hook/result' && 'exitCode' in res.data).toBe(false)
    })
  })

  if (selected.has('payload')) describe('hooks-codex coverage — continuation, payload, and cwd mapping', () => {
    it('a blocking Stop hook with EMPTY stderr still forces continuation (no reason required)', async () => {
    // Regression: an exit-2 Stop hook with no stderr yields decision 'deny' +
    // reason undefined; the turn must STILL force-continue, not silently stop.
      const d = dir()
      const marker = join(d, 'fired')
      hooks(d, { Stop: [{ hooks: [{ type: 'command', command: sh(d, 's.sh', `#!/usr/bin/env bash\nif [ -e "${marker}" ]; then exit 0; fi\ntouch "${marker}"\nexit 2\n`) }] }] })
      const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      expect(adapter.requests).toHaveLength(2) // empty-reason block forced continuation
      expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('blocked by Stop hook')
    })

    it('a clean UserPromptSubmit hook that prints PLAIN stdout injects it as context', async () => {
    // Codex feeds a SessionStart/UserPromptSubmit hook's PLAIN (non-JSON) stdout
    // as additionalContext (unlike CC, which needs a JSON hookSpecificOutput).
      const d = dir()
      hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: sh(d, 'ctx.sh', '#!/usr/bin/env bash\necho "extra guidance from a plain hook"\nexit 0\n') }] }] })
      const adapter = new MockAdapter([textResponse('ok')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('extra guidance from a plain hook')
    })

    it('a NON-clean SessionStart hook (exit 2) does NOT inject its stdout as context', async () => {
    // SessionStart cannot block, but non-clean stdout still must not become context. The marker
    // waits for detached completion; `echo stale; exit 2` then proves the exit-code gate matches
    // the codec's structured-stdout rule.
      const d = dir()
      const marker = join(d, 'ran')
      hooks(d, { SessionStart: [{ hooks: [{ type: 'command', command: sh(d, 'b.sh', `#!/usr/bin/env bash\ntouch "${marker}"\necho "stale"\nexit 2\n`) }] }] })
      const adapter = new MockAdapter([textResponse('ok')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      await waitFor(() => existsSync(marker)) // the exit-2 hook has finished
      expect(events(agent).some(e => e.type === 'user/message'
      && e.data.content.some(b => b.type === 'text' && b.text.includes('stale')))).toBe(false)
    })

    it('a UserPromptSubmit hook with a non-blocking error exit (1) + stdout does NOT inject it', async () => {
    // Exit 1 is a non-blocking error (no decision), so the prompt is NOT blocked
    // and the handler falls through to the context path — the gate must still
    // suppress the error hook's stdout ("stale" never reaches the model).
      const d = dir()
      hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: sh(d, 'e.sh', '#!/usr/bin/env bash\necho "stale"\nexit 1\n') }] }] })
      const adapter = new MockAdapter([textResponse('ok')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      expect(adapter.requests).toHaveLength(1) // exit 1 is non-blocking → the turn ran
      expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain('stale')
    })

    it('a clean SessionStart hook that prints PLAIN stdout injects it (not JSON)', async () => {
      const d = dir()
      hooks(d, { SessionStart: [{ hooks: [{ type: 'command', command: sh(d, 'ss.sh', '#!/usr/bin/env bash\necho "session preamble"\nexit 0\n') }] }] })
      const adapter = new MockAdapter([textResponse('ok')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      await waitFor(() => agent.inbox.nextStep.some(message =>
        message.content.some(block => block.type === 'text' && block.text.includes('session preamble'))))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('session preamble')
    })

    it('a clean hook that prints JSON is NOT injected as prose (plain-stdout gate)', async () => {
    // A structured (JSON) stdout must go through the hookSpecificOutput path, not
    // be dumped verbatim as context — the `!startsWith('{')` gate guards this.
      const d = dir()
      hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: sh(d, 'j.sh', '#!/usr/bin/env bash\necho \'{"unrelated":"json"}\'\nexit 0\n') }] }] })
      const adapter = new MockAdapter([textResponse('ok')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain('unrelated')
    })

    it('the PreToolUse payload carries the REAL tool name (matches the matcher subject)', async () => {
    // Regression: the payload once hardcoded tool_name "Bash", disagreeing with
    // the exec.name matcher subject — a config matcher on the real name would
    // then never fire. Capture the payload and assert tool_name === the real name.
      const d = dir()
      const cap = join(d, 'payload')
      hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'cap.sh', `#!/usr/bin/env bash\ncat > "${cap}"\nexit 0\n`) }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'shell', { command: 'ls' }), textResponse('done')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      ctx.tools.register(defineContentToolFixture({ name: 'shell', description: 'b', parameters: { command: { type: 'string' } }, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      const payload = JSON.parse(readFileSync(cap, 'utf8')) as { tool_name: string; tool_input: { command: string } }
      expect(payload.tool_name).toBe('shell')
      expect(payload.tool_input.command).toBe('ls')
    })

    it('a Codex matcher on the REAL tool name fires (matcher subject === payload tool_name)', async () => {
    // A regex matcher matching the real tool name must select the hook — proving
    // the matcher subject and the payload tool_name agree.
      const d = dir()
      hooks(d, { PreToolUse: [{ matcher: 'shell', hooks: [{ type: 'command', command: sh(d, 'd.sh', '#!/usr/bin/env bash\nexit 2\n') }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'shell', { command: 'ls' }), textResponse('done')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      let ran = false
      ctx.tools.register(defineContentToolFixture({ name: 'shell', description: 'b', parameters: { command: { type: 'string' } }, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      expect(ran).toBe(false) // the matcher fired → the hook denied the tool
      expect(events(agent).some(e => e.type === 'hook/invoked' && e.data.point === 'PreToolUse')).toBe(true)
    })

    it('a hook emitting a systemMessage is warned as not-yet-surfaced', async () => {
      const d = dir()
      hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: sh(d, 'sm.sh', '#!/usr/bin/env bash\necho \'{"systemMessage":"heads up"}\'\n') }] }] })
      const adapter = new MockAdapter([textResponse('ok')])
      const ctx = await harness(join(d, 'hooks.json'), adapter)
      const warn = vi.fn(); ctx.logger.warn = warn as never
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })); await waitForIdle(ctx, agent)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('systemMessage'))
      expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain('heads up')
    })

    it('runs an agent-scoped hook in the session cwd, not the executor default', async () => {
    // Same regression as the CC bridge: the Codex bridge must thread the session
    // cwd as the hook workdir. Executor default = serverDir; session cwd =
    // sessionDir; the PreToolUse hook's `pwd` marker must land in sessionDir.
      const serverDir = dir()
      const sessionDir = dir()
      const marker = join(sessionDir, 'where')
      hooks(serverDir, { PreToolUse: [{ hooks: [{ type: 'command', command: 'pwd > where' }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'x' }), textResponse('done')])
      const ctx = new Context()
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000, cwd: serverDir })
      await ctx.plugin(HooksCodex, { configPath: join(serverDir, 'hooks.json'), model: 'm' })
      ctx.llm.registerAdapter(['mock'], adapter)
      ctx.tools.register(defineContentToolFixture({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      const { SessionId } = await import('@deepseek-ai/dsh-session')
      const handle = await ctx.agents.create({ sessionId: SessionId('s1'), meta: { cwd: sessionDir }, agentOptions: { provider: 'mock', model: 'mock' } })
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, handle.agent)
      expect(existsSync(marker)).toBe(true)
      expect(readFileSync(marker, 'utf8').trim().endsWith(sessionDir.split('/').pop()!)).toBe(true)
      await handle.dispose()
    })
  })
}
