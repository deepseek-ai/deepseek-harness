/** Real Agent, Tools, card service and projections with controlled Creator and profile operations. */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, onTestFinished, vi } from 'vitest'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Skills from '@deepseek-ai/dsh-skill'
import * as SkillTool from '@deepseek-ai/dsh-tool-skill'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import ActionCards from '@deepseek-ai/dsh-action-cards'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BundleInfo, ChangeResult } from '@deepseek-ai/dsh-plugin-manager/types'
import type { SubagentActivationSpec, SubagentResult } from '@deepseek-ai/dsh-subagent'
import * as CreationRecommendations from '../src/index.ts'
import type { PageData } from '../src/types.ts'

export const ACTION = 'create_personalized_page'
/** Text of an accepted `create_personalized_page` call's result. */
export const RESULT_TEXT = 'Card shown below your answer. Do not restate it. End with at most one short invitation in the user’s language, in the first '
  + 'person: after they click Create below, you will build it in the background as a plugin page that stays available, without blocking the chat; '
  + 'the build takes minutes and many tokens.'
export const callId = ToolCallId('call-creation-1')
export const proposal = { title: 'Counter', brief: 'Keep a counter visible for this task.', details: { slot: 'sidebar-right' as const } }

/** A page card's recorded phase with its data flattened, as the tests compare it. */
export type PageCardState = PageData & { readonly callId: ToolCallId; readonly phase: string }

/** Record a page decision the way the plugin does. */
export function recordCard(session: Agent['session'], { callId: id, phase, ...data }: PageCardState): void {
  const fields = Object.fromEntries(Object.entries(data).flatMap(([key, value]) => value === undefined ? [] : [[key, value] as const]))
  appendPluginRecord(session, 'plugin:action-cards/decision', { callId: id, action: ACTION, phase, data: fields })
}

export function installedBundle(name: string): BundleInfo {
  return { name, official: false, optional: false, availability: 'profile', installed: true,
    enabled: true, removable: true, updatable: true, rows: [], overrides: [] }
}

export async function writeBundle(directory: string, name: string): Promise<void> {
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module',
    main: './index.js', exports: { '.': './index.js', './client': './index.js' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await writeFile(join(directory, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: name + ':counter', name }] }]))
  await writeFile(join(directory, 'index.js'), 'export function apply(ctx) { ctx.provide("createdCounter", true) }\n')
}

export async function fixture(initial?: PageCardState) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-creation-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const harness = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(Skills)
  await ctx.plugin(SkillTool)
  await ctx.plugin(ActionCards)
  const bundles: BundleInfo[] = []
  const manager = {
    listBundles: vi.fn(async (): Promise<BundleInfo[]> => bundles),
    installBundle: vi.fn(async (path: string): Promise<ChangeResult> => {
      bundles.push(installedBundle(current()!.bundleName!))
      return { application: 'applied', changed: true, stage: 'install', target: path }
    }),
    removeBundle: vi.fn(async (name: string): Promise<ChangeResult> => {
      bundles.splice(bundles.findIndex(bundle => bundle.name === name), 1)
      return { application: 'applied', changed: true, stage: 'remove', target: name }
    }),
  }
  const result = Promise.withResolvers<SubagentResult>()
  const entered = Promise.withResolvers<SubagentActivationSpec>()
  const dispose = vi.fn(async () => { result.resolve({ output: [], stopReason: 'aborted' }) })
  const startActivation = vi.fn(async (spec: SubagentActivationSpec) => {
    entered.resolve(spec)
    return { childId: spec.childId!, result: result.promise, dispose }
  })
  ctx.provide('pluginManager', manager)
  ctx.provide('subagents', { startActivation })
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  ctx.provide('profileContext', { dir: directory, cwd: workspace })
  const agentHandle = await ctx.agents.create({ sessionId: SessionId('creation-root'), meta: { cwd: workspace } })
  const agent = agentHandle.agent
  const events: SessionEvent[] = []
  ctx.on('session/event', (session, event) => { if (session === agent.session) events.push(event) })
  if (initial !== undefined) recordCard(agent.session, initial)
  const fiber = await ctx.plugin(CreationRecommendations)
  const cardOf = (id: ToolCallId, caller: Agent = agent): PageCardState | undefined => {
    const decision = ctx.actionCards.view(caller.session).decisions[id]
    return decision === undefined ? undefined : { callId: decision.callId, phase: decision.phase, ...decision.data } as PageCardState
  }
  const current = (): PageCardState | undefined => cardOf(callId)
  /** Log a successful propose_action call, as the card tool would after the skill load. */
  let step = 0
  const propose = async (id = 'call-creation-1', args: object = proposal, caller = agent) => {
    const turn = Math.max(1, ctx.agents.turnBoundaryOf(caller.session).lastTurn)
    const toolCallId = ToolCallId(id)
    caller.session.append('tool/call', { turn, step: ++step, callId: toolCallId, name: 'propose_action', arguments: JSON.stringify({ action: ACTION, ...args }) })
    caller.session.append('tool/result', { turn, step, message: createToolResultMessage({ callId: toolCallId,
      content: [{ type: 'text', text: RESULT_TEXT }], isError: false }) }, { surfaceOp: 'append' })
    await Promise.resolve()
    return toolCallId
  }
  /** Send one card action the way the page body does: Create and Not now carry the chosen location. */
  const act = (verb: string, slot = 'page', customLocation?: string, caller = agent, id = callId) =>
    ctx.actionCards.act(caller, id, verb, verb === 'create' || verb === 'dismiss'
      ? { slot, ...customLocation === undefined ? {} : { customLocation } } : undefined)
  const complete = async () => {
    const spec = await entered.promise
    await writeBundle(spec.request.cwd!, current()!.bundleName!)
    result.resolve({ output: [], stopReason: 'completed', structured: { ready: true } })
    await vi.waitFor(() => { expect(current()?.phase).toBe('installed') })
    return spec
  }
  return { ctx, agent, agentHandle, harness, directory, manager, bundles, startActivation, dispose, result, entered,
    fiber, propose, act, current, cardOf, complete, events }
}
