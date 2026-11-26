/** Web tools that each Agent sees only while its model route can use them. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-credentials'
import { AgentToolRegistry } from '@deepseek-ai/dsh-tools/pipeline'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/**
 * Register a Web tool that each Agent sees only while the route of its next
 * step is ready. The check asks about the provider `agent.model.current()`
 * names and runs when the Agent is created, which awaits it; when its Session
 * records a model selection, a request on another route, or a preset change;
 * when a credential or the set of Web providers changes; and for Agents that
 * exist when the plugin loads. A step that starts while a check runs uses the
 * previous answer, and a newer check for the same Agent discards an older
 * one's answer. A rejected check hides the tool from that Agent and logs one
 * warning per provider until a check for that provider succeeds.
 * @param ctx - plugin context owning the registration and its listeners.
 * @param tool - Web tool definition.
 * @param ready - whether the provider's Web backend can authenticate for the route; `provider` is undefined when the Agent has no route.
 * @returns the registry holding the tool; `get(tool.name, agent)` reports whether that Agent currently has it.
 */
export function addWhenRouteReady(
  ctx: Context, tool: ToolDefinition, ready: (provider: string | undefined) => Promise<boolean>,
): AgentToolRegistry {
  const registry = new AgentToolRegistry()
  ctx.effect(() => registry.register(tool), `tool-web.${tool.name}`)
  ctx.tools.include(registry)
  let closed = false
  ctx.effect(() => () => { closed = true }, `tool-web.${tool.name}.checks`)
  // The latest check for each Agent, keyed by identity so a newer check supersedes it.
  const checks = new WeakMap<Agent, { provider: string | undefined }>()
  // Providers whose failed check was already reported; a successful check re-arms the warning.
  const failing = new Set<string | undefined>()
  // An answer that settles after unload is dropped silently.
  const report = (level: 'warn' | 'error', message: string, error: unknown): void => {
    if (!closed) ctx.logger[level](`${message}: %o`, error)
  }
  const check = async (agent: Agent): Promise<void> => {
    const latest = { provider: agent.model.current()?.provider }
    checks.set(agent, latest)
    let available = false
    try {
      available = await ready(latest.provider)
      failing.delete(latest.provider)
    } catch (error: unknown) {
      if (!failing.has(latest.provider)) {
        failing.add(latest.provider)
        report('warn', `tool-web: cannot check whether ${tool.name} is available on provider ${JSON.stringify(latest.provider)} (Session ${agent.id}); Agents on that provider do not see it until a later check succeeds. Check that provider's Web credentials and settings`, error)
      }
    }
    if (!closed && checks.get(agent) === latest) registry.set(agent, available ? [tool.name] : [])
  }
  const checkInBackground = (agent: Agent): void => {
    check(agent).catch((error: unknown) => { report('error', `tool-web: cannot update ${tool.name} for Session ${agent.id}`, error) })
  }
  const checkAll = (): void => {
    for (const agent of ctx.agents.list()) checkInBackground(agent)
  }
  ctx.on('agent/created', async ({ agent }) => { await check(agent) })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'model/selection' && event.type !== 'request/header' && event.type !== 'agent-preset/selected') return
    const agent = ctx.agents.get(session.id)
    if (agent === undefined) return
    // A recorded selection or request changes the route only when it names another provider.
    if (event.type !== 'agent-preset/selected' && checks.get(agent)?.provider === agent.model.current()?.provider) return
    checkInBackground(agent)
  })
  ctx.on('credentials/reference-updated', checkAll)
  ctx.on('credentials/record-updated', checkAll)
  ctx.on('web/providers-changed', checkAll)
  checkAll()
  return registry
}
