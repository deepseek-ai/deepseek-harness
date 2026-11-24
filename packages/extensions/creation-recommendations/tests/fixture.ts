/** Real Agent, card service and projections with controlled Creator and profile operations. */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, onTestFinished, TestRunner, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Skills from '@deepseek-ai/dsh-skill'
import * as SkillTool from '@deepseek-ai/dsh-tool-skill'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import ActionCards, { type ActionCardId } from '@deepseek-ai/dsh-action-cards'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BundleInfo, ChangeResult } from '@deepseek-ai/dsh-plugin-manager/types'
import type { SubagentActivationSpec, SubagentResult } from '@deepseek-ai/dsh-subagent'
import * as CreationRecommendations from '../src/index.ts'
import type { PageData } from '../src/types.ts'

export const ACTION = 'create_personalized_page'
export const cardId = brandString<ActionCardId>('card-creation-1')
export const proposal = { title: 'Counter', brief: 'Keep a counter visible for this task.', details: { slot: 'sidebar-right' as const } }

/** A page card's recorded phase with its data flattened, as the tests compare it. */
export type PageCardState = PageData & { readonly cardId: ActionCardId; readonly phase: string }

/** Record a page decision the way the plugin does. */
export function recordCard(session: Agent['session'], { cardId: id, phase, ...data }: PageCardState): void {
  const fields = Object.fromEntries(Object.entries(data).flatMap(([key, value]) => value === undefined ? [] : [[key, value] as const]))
  session.append('action-cards/decision', { cardId: id, action: ACTION, phase, data: fields })
}

export function installedBundle(name: string): BundleInfo {
  return { name, official: false, optional: false, availability: 'profile', installed: true,
    enabled: true, removable: true, update: 'registry', rows: [], overrides: [] }
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
  const agentHandle = await ctx.agents.create({ sessionId: brandString<SessionId>('creation-root'), meta: { cwd: workspace } })
  const agent = agentHandle.agent
  const events: SessionEvent[] = []
  ctx.on('session/event', (session, event) => { if (session === agent.session) events.push(event) })
  if (initial !== undefined) recordCard(agent.session, initial)
  const fiber = await ctx.plugin(CreationRecommendations)
  const cardOf = (id: ActionCardId, caller: Agent = agent): PageCardState | undefined => {
    const decision = ctx.actionCards.view(caller.session).decisions[id]
    return decision === undefined ? undefined : { cardId: decision.cardId, phase: decision.phase, ...decision.data } as PageCardState
  }
  const current = (): PageCardState | undefined => cardOf(cardId)
  /** Log an answer that ends with a card block, named by the answer message id, as the loop does after the model responds. */
  let step = 0
  const propose = async (id = 'card-creation-1', args: object = proposal, caller = agent) => {
    const turn = Math.max(1, ctx.agents.turnBoundaryOf(caller.session).lastTurn)
    const text = `I can build it.\n\n\`\`\`action-card\n${JSON.stringify({ action: ACTION, ...args })}\n\`\`\`\n`
    caller.session.append('assistant/message', { turn, step: ++step, stream: [], message: { id: brandString<MessageId>(id), role: 'assistant',
      content: [{ type: 'text', text }], source: { kind: 'model', provider: 'test', model: 'test' } } }, { surfaceOp: 'append' })
    await Promise.resolve()
    return brandString<ActionCardId>(id)
  }
  /** Send one card action the way the page body does: Create and Not now carry the chosen location. */
  const act = (verb: string, slot = 'page', customLocation?: string, caller = agent, id = cardId) =>
    ctx.actionCards.act(caller, id, verb, verb === 'create' || verb === 'dismiss'
      ? { slot, ...customLocation === undefined ? {} : { customLocation } } : undefined)
  const complete = async () => {
    const spec = await entered.promise
    await writeBundle(spec.cwd!, current()!.bundleName!)
    result.resolve({ output: [], stopReason: 'completed', structured: { ready: true } })
    // Bundle validation and the profile copy perform real filesystem I/O within the test's lane budget.
    await vi.waitFor(() => { expect(current()?.phase).toBe('installed') }, { timeout: TestRunner.getCurrentTest()!.timeout })
    return spec
  }
  return { ctx, agent, agentHandle, harness, directory, manager, bundles, startActivation, dispose, result, entered,
    fiber, propose, act, current, cardOf, complete, events }
}
