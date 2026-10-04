import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { CordisDynamicPluginId } from '../src/types.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import DynamicCordisRunnerService from '../src/index.ts'
import type { Config } from '../src/index.ts'

/**
 * Shared spec harness: a real `SystemPrompt` + `ToolRegistry` + timer tree with
 * the runner mounted and a recording stand-in for the web gateway. Only the
 * model and the browser are absent — the code strings below stand in for what
 * the model would write, and the gateway records (and optionally answers) every
 * dispatch.
 */

/** One recorded broadcast plus how the fake browser answers a run request. */
interface Gateway {
  /** Every forwarded event the runner emitted, in order, as `[name, payload]`. */
  events: [name: string, payload: unknown][]
  /**
   * How the fake browser answers the next run request, standing in for a person
   * at the panel: it orchestrates exactly as the real client runner does (bring
   * the host half up, fetch the source, answer), or declines.
   */
  answer?: 'approve' | 'reject' | { clientFails: string }
  /** Services the fake browser reports its half is parked on. */
  clientWaitingFor?: string[]
  /** Completion of the fake page's latest asynchronous answer. */
  answering?: Promise<void>
}

/** The session that owns every definition these suites define. */
export const AGENT_A = { id: 'S-a' as SessionId, steer() {}, inject() {} } as unknown as Agent
/** A second session, for the authority-scoping cases. */
export const AGENT_B = { id: 'S-b' as SessionId, steer() {}, inject() {} } as unknown as Agent

/** One live tree: the context, the runner, and the recording gateway. */
interface Harness {
  ctx: Context
  runner: DynamicCordisRunnerService
  gateway: Gateway
}

/**
 * Build a real tree with the runner mounted and a recording gateway provided.
 * @param config - runner configuration overrides.
 * @returns the context, the runner service, and the gateway recorder.
 */
export async function setup(config?: Config): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  const gateway: Gateway = { events: [] }
  ctx.on('cordis/request-run', (request) => {
    gateway.events.push(['cordis/request-run', request])
    // The fake browser: a request reaches it, and it answers the way the real
    // client runner does — nothing here is a shortcut through the host's own
    // verbs, so the round trip under test is the real one.
    if (gateway.answer === undefined) return
    const answer = gateway.answer
    const { requestId, pluginId, packageId, mode } = request
    gateway.answering = Promise.resolve().then(async (): Promise<void> => {
      if (answer === 'reject') {
        await runner.resolveRequestRun(requestId, { ok: false, reason: 'rejected', message: 'not now' })
        return
      }
      const half = await runner.runHostHalf(AGENT_A, pluginId, packageId, mode, requestId, false)
      if (!half.ok) {
        await runner.resolveRequestRun(requestId, {
          ok: false, reason: 'host-half-failed', message: half.message,
        })
        return
      }
      if (typeof answer === 'object') {
        await runner.resolveRequestRun(requestId, {
          ok: false,
          reason: 'client-half-failed',
          pluginRunId: half.pluginRunId,
          startedHere: half.startedHere,
          message: answer.clientFails,
        })
        return
      }
      const source = runner.getClientCode(AGENT_A, pluginId, half.pluginRunId)
      await runner.resolveRequestRun(requestId, {
        ok: true,
        pluginRunId: source.pluginRunId,
        ...gateway.clientWaitingFor === undefined ? {} : { waitingFor: gateway.clientWaitingFor },
      })
    })
  })
  for (const name of ['cordis/request-run-resolved', 'cordis/dynamic-package', 'cordis/dynamic-retract'] as const) {
    ctx.on(name, (payload: unknown) => { gateway.events.push([name, payload]) })
  }
  await ctx.plugin(DynamicCordisRunnerService, config)
  const runner = ctx.dynamicCordisRunner
  return { ctx, runner, gateway }
}

/**
 * One session's packages and whether each runs, projected from the global
 * inventory — the reading a surface takes now that there is no session-scoped
 * list verb.
 * @param runner - the live runner service.
 * @param agent - the session to project.
 * @returns id/running pairs in define order.
 */
export function running(runner: DynamicCordisRunnerService, agent: Agent): { id: string; running: boolean }[] {
  return runner.inventory()
    .filter(row => row.agentId === agent.id)
    .map(row => ({ id: String(row.pluginId), running: row.activeRun !== undefined }))
}

let definitionCounter = 0

/**
 * Define and run one host half in one step, the way the ported suites exercise
 * the sandbox: a failure in either verb rejects with the runner's own
 * model-facing message, so a spec asserts teaching text through `rejects`.
 * @param harness - the live tree.
 * @param code - the host-half source.
 * @returns the definition id of the running package.
 * @throws the runner's refusal message when define prechecks or the run fails.
 */
export async function mount(harness: Harness, code: string): Promise<CordisDynamicPluginId> {
  const { pluginId, packageId } = harness.runner.define({
    sessionId: AGENT_A.id,
    plugin: { kind: 'new', idPrefix: 'probe' },
    name: `probe-${++definitionCounter}`,
    purpose: 'spec fixture',
    code: { host: code },
  })
  const receipt = await harness.runner.run(AGENT_A, pluginId, packageId, 'run')
  if (!receipt.ok) throw new Error(receipt.message)
  return pluginId
}

let callCounter = 0

/** Execute a registered tool through the real registry pipeline. */
export function call(ctx: Context, name: string, args: unknown): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: args,
  })
}

/** Concatenated text blocks of one tool result. */
export function text(result: ToolExecutionResult): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Explicit content-array output declaration for dynamic-tool behavior fixtures. */
export const CONTENT_OUTPUT_CODE = `
              output: {
                schema: { type: 'array', items: { type: 'json' } },
                render(_args, value) { return value },
              },`

/** Browser-half source the fake browser "loads"; its content never runs in these suites. */
export const CLIENT_CODE = 'return () => {}'

/** Host-half source for a listener package: logs on every `tools/change`. */
export const LISTENER_CODE = `
  return {
    name: 'change-logger',
    apply(ctx) {
      ctx.on('tools/change', () => console.log('tools changed'))
    },
  }
`

/** Host-half source registering a self-made tool through the sandbox harness helpers. */
export const REVERSE_TOOL_CODE = `
  return {
    name: 'reverse-text',
    inject: ['tools'],
    apply(ctx) {
      harness.registerTool(ctx, harness.defineTool({
        name: 'reverse_text',
        description: 'Reverse a string.',
        parameters: { text: { type: 'string', required: true } },
        output: {
          schema: { type: 'string' },
          render(_args, value) {
            return [{ type: 'text', text: value }]
          },
        },
        async execute(args) {
          return args.text.split('').reverse().join('')
        },
      }))
    },
  }
`

/** Host-half source providing a `greeter` service other packages can inject. */
export const PROVIDER_CODE = `
  return {
    name: 'greeter-provider',
    apply(ctx) {
      ctx.provide('greeter', { greet: (name) => 'hi ' + name })
    },
  }
`

/** Host-half source consuming the `greeter` service through inject, exposing it as a tool. */
export const CONSUMER_CODE = `
  return {
    name: 'greeter-consumer',
    inject: ['greeter', 'tools'],
    apply(ctx) {
      harness.registerTool(ctx, harness.defineTool({
        name: 'greet',
        description: 'Greet someone via the greeter service.',
        parameters: { name: { type: 'string', required: true } },
        output: {
          schema: { type: 'string' },
          render(_args, value) {
            return [{ type: 'text', text: value }]
          },
        },
        async execute(args) {
          return ctx.greeter.greet(args.name)
        },
      }))
    },
  }
`

/** A registrable no-op tool the tests use as a schema-view target. */
export function dummyTool(name: string): ToolDefinition {
  return {
    name,
    description: 'test trigger',
    parameters: { type: 'object' as const, properties: {} },
    output: { schema: { type: 'null' }, render: () => [] },
    async execute(): Promise<null> {
      return null
    },
  }
}
