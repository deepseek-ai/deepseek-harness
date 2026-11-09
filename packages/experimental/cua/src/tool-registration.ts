/** Agent-scoped CUA transports sharing a provider-owned persistent program runtime. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import NodePtcRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import { createRunCodeTool } from '@deepseek-ai/dsh-tool-executor-ptc/run-code'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { CuaConfig } from './index.ts'

const programDescription = 'Run a TypeScript program to observe and operate desktop applications. '
  + 'The global cua object is ready to use; retain application and window objects across calls. '
  + 'Only tools.cua is available inside the program. Call other session tools directly. '
  + 'Print the values you need or leave a final expression; screenshots are attached after the program finishes.'

/**
 * Register raw CUA for its configured PTC preset and a persistent program tool for other presets.
 * @param ctx Provider context owning native calls and registrations.
 * @param config Validated preset selection and dedicated runtime bounds.
 * @param tool Internal native tool; non-PTC Agents can reach it only through the program.
 * @param guidance Platform and shared CUA operation instructions.
 * @returns Exact registration disposer, draining programs before native resources can close.
 */
export function installCuaTools(ctx: Context, config: CuaConfig, tool: ToolDefinition, guidance: string): () => void | Promise<void> {
  const bridgeUrl = JSON.stringify(new URL('../lib/bridge.js', import.meta.url).href)
  const prompt = { name: 'computer-use:dsh-cua', order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE') }
  const rawPrompt: PromptSection = { ...prompt, text: () => {
    const runtime = ctx.get('ptcRuntime')
    return !runtime?.retainsState ? guidance : `${guidance}

Persistent PTC initialization:

\`\`\`ts
var { connectCua } = await import(${bridgeUrl});
var cua = connectCua(() => tools.cua, text => console.log(text));
\`\`\``
  } }
  const register = (scope: Context, definition: ToolDefinition, instructions: PromptSection): (() => void) => {
    const removeTool = scope.tools.register(definition)
    const removePrompt = scope.systemPrompt.section(instructions)
    return () => { removePrompt(); removeTool() }
  }
  if (config.agentPreset === false) return register(ctx, tool, rawPrompt)
  return ctx.effect(function* () {
    const runtimeCtx = ctx.isolate('ptcRuntime')
    const runtime = runtimeCtx.plugin(NodePtcRuntime, {
      ...config.runCode.runtime, executionMode: 'persistent-in-memory', scriptPersistence: false,
    })
    yield runtime.dispose
    const programs = runtimeCtx.plugin({
      name: 'cua-program-tools', inject: ['ptcRuntime', 'tools', 'workingDirectory', 'agentPresets', 'agents', 'systemPrompt'],
      apply(consumer: Context) {
        const program = createRunCodeTool(consumer, {
          name: 'cua_run_code', description: programDescription, runtime: consumer.ptcRuntime,
          tools: [tool], limits: config.runCode.executor,
          initialization: `globalThis.cua ??= (await import(${bridgeUrl})).connectCua(() => tools.cua, text => console.log(text));`,
        })
        const scopes = new Map<Agent, { scope: Scope; current?: { kind: 'raw' | 'program'; remove: () => void } }>()
        consumer.effect(() => async () => {
          await Promise.all([...scopes.values()].map(({ scope }) => scope.dispose()))
        }, 'cua.agent-tools')
        const sync = (agent: Agent): void => {
          const preset = consumer.agentPresets.composedPreset(agent.ctx)
          if (preset === undefined) return
          const kind = preset === config.agentPreset ? 'raw' : 'program'
          let entry = scopes.get(agent)
          if (entry?.current?.kind === kind) return
          if (entry?.current !== undefined) { entry.current.remove(); delete entry.current }
          if (entry === undefined) {
            const scope = createScope(agent.ctx, agent)
            entry = { scope }
            scopes.set(agent, entry)
            scope.ctx.effect(() => () => { scopes.delete(agent) }, 'cua.agent-tools')
          }
          const remove = register(entry.scope.ctx, kind === 'raw' ? tool : program,
            kind === 'raw' ? rawPrompt : { ...prompt, text: guidance })
          entry.current = { kind, remove }
        }
        consumer.on('agent/created', ({ agent }) => { sync(agent) })
        consumer.on('agent-preset/selected', (id) => {
          const agent = consumer.agents.get(id)
          if (agent === undefined) return
          try { sync(agent) } catch (error) { consumer.logger.warn(`CUA tool scope update failed: ${String(error)}`) }
        })
        for (const agent of consumer.agents.list()) sync(agent)
      },
    })
    yield programs.dispose
    // Creation can overlap the first provider activation; await its registered tools before the first turn.
    yield ctx.on('agent/created', async () => { await programs.await() })
  }, 'cua.program-runtime')
}
