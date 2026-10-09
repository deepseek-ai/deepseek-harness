/** Loader fixture selecting a directory after initial prompt assembly. */
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-working-directory'

/** Loader identity for the admission timing scene. */
export const name = 'working-directory-admission'
/** Directory owner used by the first pre-step transition. */
export const inject = ['workingDirectory', 'agents']

/**
 * Select the scenario's existing subdirectory before its first request.
 * @param ctx - fixture context owning the pre-step listener.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    if (turn === 1 && step === 1) await ctx.workingDirectory.set(agent, 'selected', signal)
    return next()
  })
  let first = true
  ctx.on('llm/stream', (request, next) => {
    if (!first) return next()
    first = false
    const agent = request.sessionId === undefined ? undefined : ctx.agents.get(request.sessionId)
    assert(agent !== undefined, 'admission request has no live Agent')
    const current = `Current working directory: ${JSON.stringify(ctx.workingDirectory.get(agent.session))}.`
    const old = `Current working directory: ${JSON.stringify(agent.session.header.cwd)}.`
    const snapshots = request.messages.filter(message => message.role === 'user' && message.source?.kind === 'runtime-context')
    assert.equal(snapshots.length, 1)
    const text = snapshots.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    assert(text.includes(current), 'first admitted request omits the selected directory')
    assert(!text.includes(old), 'first admitted request retains the previous directory')
    return next()
  })
}
