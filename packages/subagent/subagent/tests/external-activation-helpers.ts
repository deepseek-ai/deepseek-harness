/** Registered parent fixtures for external backend activation tests. */

import { randomUUID } from 'node:crypto'
import { onTestFinished } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { SubagentActivation, SubagentStartRequest } from '../src/types.ts'

const parents = new WeakMap<Context, Promise<WeakMap<Agent, Agent>>>()

/** Mount only the registries needed by an external child's parent; no model is driven. */
function parentStore(ctx: Context): Promise<WeakMap<Agent, Agent>> {
  const existing = parents.get(ctx)
  if (existing !== undefined) return existing
  onTestFinished(() => ctx.fiber.dispose())
  const ready = (async () => {
    if (ctx.get('sessions') === undefined) await ctx.plugin(SessionStore)
    if (ctx.get('agents') === undefined) await ctx.plugin(AgentRegistry)
    return new WeakMap<Agent, Agent>()
  })()
  parents.set(ctx, ready)
  return ready
}

/** Register a parent with a real Session and an observable, non-driving Inbox. */
export async function externalTestParent(ctx: Context, cwd?: string): Promise<Agent> {
  await parentStore(ctx)
  const session = ctx.sessions.create(SessionId(randomUUID()), {
    meta: cwd === undefined ? {} : { cwd },
  })
  const inbox = createInboxStub()
  const parent: Agent = {
    id: session.id,
    session,
    ctx,
    options: {},
    status: 'idle',
    inbox,
    send: (message, target) => { inbox.append(target, message) },
    followup: (message) => { inbox.append('next-turn', message) },
    steer: (message) => { inbox.append('next-step', message) },
    inject: (message) => { inbox.append('next-step', message) },
    cancel: (_cause, options) => { if (!options?.keepInbox) inbox.clear() },
    whenIdle: () => Promise.resolve(),
    runMaintenance: task => task(new AbortController().signal),
  }
  ctx.agents.register(parent)
  return parent
}

/** Start through the activation service while preserving a backend fixture's workspace input. */
export async function startExternalActivation(
  ctx: Context,
  provider: string,
  request: SubagentStartRequest,
): Promise<SubagentActivation> {
  const registry = await parentStore(ctx)
  let parent = ctx.agents.get(request.parent.id) === request.parent
    ? request.parent
    : registry.get(request.parent)
  if (parent === undefined) {
    parent = await externalTestParent(ctx, request.parent.session.header.cwd)
    registry.set(request.parent, parent)
  }
  const { label, signal, ...execution } = request
  return ctx.subagents.startActivation({
    provider,
    label: label ?? 'External test task',
    request: { ...execution, parent },
    signal,
    delivery: 'caller',
  })
}
