/** Agent-scoped raw CUA and persistent program tool registrations. */
import { extname } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import NodePtcRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import { createRunCodeTool } from '@deepseek-ai/dsh-tool-executor-ptc/run-code'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { longEdgeDimensions, type ImageAttachmentRef, type ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { CuaConfig } from './index.ts'
import type { CuaScreenshotTargetConfig } from './config.ts'
import { CUA_PROMPT_SECTION_NAME } from './guidance.ts'

const programDescription = 'Run a TypeScript program to observe and operate desktop applications. '
  + 'The global cua object is ready to use; retain application and window objects across calls. '
  + 'Only tools.cua is available inside the program. Call other session tools directly. '
  + 'Use inspect(...values) to display selected text and images.'

/** Host control over the dedicated `cua_run_code` environments; registered as `ctx.cuaPrograms`. */
export interface CuaPrograms {
  /**
   * Release one Agent's retained program environment with the dedicated runtime's owner release. The program
   * process exits, a program of that Agent that is still running fails as aborted, and the next `cua_run_code`
   * call starts a fresh process that re-creates the `cua` global. The Agent, its application grants and native
   * connection, and the desktop applications themselves are unaffected. The runtime rejects that Agent's
   * programs until the release settles, so the caller holds them back; after a failed release it rejects them
   * until a later release succeeds. Resolves when no environment exists.
   * @param agent - Agent whose `cua_run_code` state owner is released.
   * @returns Completion after the process has exited and its output has drained.
   * @throws When the process cleanup fails.
   */
  release(agent: Agent): Promise<void>
  /**
   * Request-image target the provider delivered for a stored screenshot when `screenshotTarget` is configured.
   * A host that forwards screenshots outside a model request reads the same request version with it, so the
   * image a caller sees matches the coordinate space the provider mapped.
   * @param image - Durable screenshot attachment from a `cua` result.
   * @returns The fixed target, or undefined when the Agent's model route selects the delivered version.
   */
  screenshotRequestTarget(image: ImageAttachmentRef): ImageRequestTarget | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Present while the CUA provider owns a dedicated program runtime. */
    cuaPrograms: CuaPrograms
  }
}

/**
 * Project a configured screenshot target onto one stored image.
 * @param configured - Validated `screenshotTarget`.
 * @param image - Durable normalized screenshot.
 * @returns The request target for that image: the long edge capped at the configured value, the configured byte budget.
 */
export function fixedScreenshotTarget(configured: CuaScreenshotTargetConfig, image: ImageAttachmentRef): ImageRequestTarget {
  return { ...longEdgeDimensions(image.width, image.height, configured.longEdge), maxBytes: configured.maxBytes }
}

/**
 * Register raw CUA for Agents on the configured preset and a persistent program tool for every other Agent,
 * including Agents without a preset and compositions without a preset registry.
 * @param ctx Provider context owning native calls and registrations.
 * @param config Validated preset selection and dedicated runtime bounds.
 * @param tool Internal native tool; Agents off the configured preset can reach it only through the program.
 * @param guidance Raw-tool operation instructions for the configured preset.
 * @param programGuidance Operation instructions available inside cua_run_code.
 * @returns Exact registration disposer, draining programs before native resources can close.
 */
export function installCuaTools(
  ctx: Context, config: CuaConfig, tool: ToolDefinition, guidance: string, programGuidance: string,
): () => void | Promise<void> {
  // PTC publishes the installed JS entry; automatic CUA initialization follows the Host's code format.
  const ptcBridgeUrl = JSON.stringify(new URL('../lib/bridge.js', import.meta.url).href)
  const programBridgeUrl = JSON.stringify(new URL(`./bridge${extname(new URL(import.meta.url).pathname)}`, import.meta.url).href)
  const prompt = { name: CUA_PROMPT_SECTION_NAME, order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE') }
  const rawPrompt: PromptSection = { ...prompt, text: () => {
    const runtime = ctx.get('ptcRuntime')
    return !runtime?.retainsState ? guidance : `${guidance}

In persistent PTC, use the host-provided bridge initialization once and retain the returned objects; cua comes from that bridge and is not a preinstalled global.

Persistent PTC initialization:

\`\`\`ts
var { connectCua } = await import(${ptcBridgeUrl});
var cua = connectCua(() => tools.cua);
\`\`\``
  } }
  const register = (scope: Context, definition: ToolDefinition, instructions: PromptSection): (() => void) => {
    const removeTool = scope.tools.register(definition)
    let removePrompt: () => void
    try { removePrompt = scope.systemPrompt.section(instructions) }
    catch (error) { removeTool(); throw error }
    return () => { try { removePrompt() } finally { removeTool() } }
  }
  if (config.agentPreset === false) return register(ctx, tool, rawPrompt)
  return ctx.inject(['tools', 'agents', 'systemPrompt'], (base) => {
    const scopes = new Map<Agent, { scope: Scope; current?: { definition: ToolDefinition; remove: () => void } }>()
    let program: ToolDefinition | undefined
    let programs: Fiber | undefined
    let closing = false
    // The preset registry is optional; while none is mounted no Agent runs the configured preset.
    const modeOf = (agent: Agent): 'raw' | 'program' =>
      base.get('agentPresets')?.composedPreset(agent.ctx) === config.agentPreset ? 'raw' : 'program'
    const sync = (agent: Agent): void => {
      const mode = modeOf(agent)
      const definition = mode === 'raw' ? tool : program
      let entry = scopes.get(agent)
      if (entry?.current?.definition === definition) return
      if (entry?.current !== undefined) { entry.current.remove(); delete entry.current }
      if (definition === undefined) return
      if (entry === undefined) {
        const scope = createScope(agent.ctx, agent)
        entry = { scope }
        scopes.set(agent, entry)
        scope.ctx.effect(() => () => { scopes.delete(agent) }, 'cua.agent-tools')
      }
      const remove = register(entry.scope.ctx, definition,
        mode === 'raw' ? rawPrompt : { ...prompt, text: programGuidance })
      entry.current = { definition, remove }
    }
    const syncAll = (): void => { for (const agent of base.agents.list()) sync(agent) }
    // A preset or registry change updates each Agent separately, so one failed registration leaves the others current.
    const resync = (agent: Agent): void => {
      try { sync(agent) } catch (error) { base.logger.warn(`CUA tool scope update failed: ${String(error)}`) }
    }
    const resyncAll = (): void => { for (const agent of base.agents.list()) resync(agent) }
    base.effect(function* () {
      yield async () => { await Promise.all([...scopes.values()].map(({ scope }) => scope.dispose())) }
      const runtimeCtx = base.isolate('ptcRuntime')
      const runtime = runtimeCtx.plugin(NodePtcRuntime, {
        ...config.standaloneRunCode.runtime, executionMode: 'persistent-in-memory', scriptPersistence: false,
      })
      yield runtime.dispose
      const initializer = runtimeCtx.plugin({
        name: 'cua-program-initializer', inject: ['ptcRuntime'],
        apply(owner: Context) {
          owner.effect(function* () {
            yield owner.ptcRuntime.registerEnvironmentInitializer(
              `globalThis.cua = (await import(${programBridgeUrl})).connectCua(() => tools.cua);`,
            )
            const child = owner.plugin({
              name: 'cua-program-tools', inject: ['ptcRuntime', 'tools', 'workingDirectory'],
              apply(consumer: Context) {
                const definition = createRunCodeTool(consumer, {
                  name: 'cua_run_code', description: programDescription, runtime: consumer.ptcRuntime,
                  tools: [tool], limits: config.standaloneRunCode.executor,
                })
                // Hosts without a model (MCP frontends) end an Agent's environment with the runtime's owner release.
                consumer.provide('cuaPrograms', {
                  release: (agent: Agent) => consumer.ptcRuntime.release(agent),
                  screenshotRequestTarget: image => config.screenshotTarget === undefined
                    ? undefined : fixedScreenshotTarget(config.screenshotTarget, image),
                } satisfies CuaPrograms)
                consumer.effect(function* () {
                  yield () => {
                    if (program !== definition) return
                    program = undefined
                    syncAll()
                  }
                  program = definition
                  syncAll()
                }, 'cua.program-publication')
              },
            })
            programs = child
            yield () => { programs = undefined }
            yield child.dispose
          }, 'cua.environment-initializer')
        },
      })
      yield initializer.dispose
      yield base.on('agent/created', async ({ agent }) => {
        if (closing) return
        if (modeOf(agent) === 'program') {
          if (runtime.uid !== null) await runtime.await()
          await initializer.await()
          await programs?.await()
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- Provider teardown can run while readiness awaits.
          if (closing) return
          if (modeOf(agent) === 'program' && program === undefined) {
            throw new Error('CUA program tool is unavailable; restore its private runtime and workingDirectory services, or reload the provider')
          }
        }
        sync(agent)
      })
      yield base.on('agent-preset/selected', (id) => {
        const agent = base.agents.get(id)
        if (agent !== undefined) resync(agent)
      })
      yield base.inject(['agentPresets'], (registry) => {
        registry.effect(() => () => { if (!closing) resyncAll() }, 'cua.preset-registry')
        resyncAll()
      }).dispose
      yield () => {
        closing = true
        program = undefined
        for (const entry of scopes.values()) {
          entry.current?.remove()
          delete entry.current
        }
      }
      syncAll()
    }, 'cua.program-runtime')
  }).dispose
}
