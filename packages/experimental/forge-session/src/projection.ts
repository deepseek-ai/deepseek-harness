/** Projection that folds shell results and binding records into one Session's change request bindings, and shows clients the bindings. */

import { z } from 'zod'
import { pluginRecordOf, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { changeRequestUrls, commandEvidence, commandOf, ownChangeRequestUrls, pushedBranches, sameChangeRequestUrl } from './commands.ts'
import type { PushedRef } from './commands.ts'
import type { BindingOrigin, BindingRecord, BindingState, ForgeChangeRequestsState, PushedBranch } from './types.ts'

/** Plugin record type of binding actions. */
export const BINDING_RECORD = 'plugin:forge-session/binding'

/** Tools whose calls run shell commands with a string `command` argument. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'pwsh'])

const EMPTY: ForgeChangeRequestsState = Object.freeze({
  pending: Object.freeze([]),
  bindings: Object.freeze([]),
  pushes: Object.freeze([]),
})

const bindingRecordSchema: z.ZodType<BindingRecord> = z.object({
  action: z.enum(['track', 'dismiss', 'discover', 'reference']),
  url: z.string().regex(/^https?:\/\/\S+$/),
})

const bindingsSchema: z.ZodType<readonly BindingState[]> = z.array(z.object({
  url: z.string(),
  origin: z.enum(['created', 'referenced', 'discovered', 'tracked']),
  dismissed: z.boolean(),
}).strict())

const stateSchema: z.ZodType<ForgeChangeRequestsState> = z.object({
  pending: z.array(z.object({
    callId: z.string(),
    urls: z.enum(['created', 'referenced']).nullable(),
    pushes: z.boolean(),
    named: z.array(z.string()),
  }).strict()),
  bindings: bindingsSchema,
  pushes: z.array(z.object({
    remote: z.string(),
    branch: z.string(),
    seq: z.number().int().nonnegative().transform(value => SessionSeq(value)),
  }).strict()),
}).strict()

/**
 * The `forgeChangeRequests` unit. A `bash` or `pwsh` call whose command is
 * `gh pr create`, `gh pr view`, `gh pr edit`, `gh pr checkout`, or
 * `git push` stays pending until its first result. A successful result binds
 * every pull request URL a `gh pr create` result prints; for the other `gh pr`
 * commands it binds the URL the command names and the URL the output prints
 * for its own change request; and it records the branches it reports as
 * pushed. Failed tool executions bind nothing; a nonzero exit status does not
 * matter, because the URL or ref line is the evidence. `turn/end` drops calls
 * that never received a result. Binding records bind, restore, and hide URLs.
 * Clients, including the Session summary, see the bindings; the array keeps
 * its reference while only pending calls and pushes change.
 */
export const forgeChangeRequestsProjection = {
  key: 'forgeChangeRequests',
  stateVersion: 3,
  stateSchema,
  init: () => EMPTY,
  apply,
  wire: { viewSchema: bindingsSchema, view: state => state.bindings },
} satisfies ProjectionDefinition<'forgeChangeRequests', ForgeChangeRequestsState>

function apply(state: ForgeChangeRequestsState, event: SessionEvent): ForgeChangeRequestsState {
  switch (event.type) {
    case 'tool/call':
      return applyCall(state, event.data)
    case 'tool/result':
      return applyResult(state, event.data, event.seq)
    case 'turn/end':
      return state.pending.length === 0 ? state : { ...state, pending: EMPTY.pending }
    // Every other event type, including plugin records, which sit outside SessionEventMap.
    default:
      return applyRecord(state, event)
  }
}

function applyCall(state: ForgeChangeRequestsState, call: SessionEventMap['tool/call']): ForgeChangeRequestsState {
  if (!SHELL_TOOLS.has(call.name)) return state
  const command = commandOf(call.arguments)
  const evidence = command === undefined ? undefined : commandEvidence(command)
  if (evidence === undefined) return state
  return { ...state, pending: [...state.pending, { callId: call.callId, ...evidence }] }
}

function applyResult(state: ForgeChangeRequestsState, result: SessionEventMap['tool/result'], seq: SessionSeq): ForgeChangeRequestsState {
  const callId = result.message.toolCallId
  const pending = state.pending.find(entry => entry.callId === callId)
  if (pending === undefined) return state
  const rest = state.pending.filter(entry => entry !== pending)
  if (result.message.isError === true) return { ...state, pending: rest }
  const text = result.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  const printed = pending.urls === 'created' ? changeRequestUrls(text) : ownChangeRequestUrls(text)
  return {
    pending: rest,
    bindings: pending.urls === null ? state.bindings : bind(state.bindings, [...pending.named, ...printed], pending.urls),
    pushes: pending.pushes ? recordPushes(state.pushes, pushedBranches(text), seq) : state.pushes,
  }
}

function applyRecord(state: ForgeChangeRequestsState, event: SessionEvent): ForgeChangeRequestsState {
  const record = pluginRecordOf(event)
  if (record?.type !== BINDING_RECORD) return state
  const parsed = bindingRecordSchema.safeParse(record.data)
  if (!parsed.success) return state
  const { action, url } = parsed.data
  const index = state.bindings.findIndex(binding => sameChangeRequestUrl(binding.url, url))
  const existing = state.bindings[index]
  switch (action) {
    case 'reference':
      return existing === undefined ? { ...state, bindings: bind(state.bindings, [url], 'referenced') } : state
    case 'discover':
      return existing === undefined ? { ...state, bindings: bind(state.bindings, [url], 'discovered') } : state
    case 'track':
      if (existing === undefined) return { ...state, bindings: bind(state.bindings, [url], 'tracked') }
      return existing.dismissed ? { ...state, bindings: state.bindings.with(index, { ...existing, dismissed: false }) } : state
    case 'dismiss':
      return existing !== undefined && !existing.dismissed
        ? { ...state, bindings: state.bindings.with(index, { ...existing, dismissed: true }) }
        : state
    /* v8 ignore next -- closed BindingRecord action union exhaustiveness guard */
    default: return assertNever(action, 'BindingRecord.action')
  }
}

/** Append each URL not already bound; returns the input array when nothing is new. */
function bind(bindings: readonly BindingState[], urls: readonly string[], origin: BindingOrigin): readonly BindingState[] {
  let next = bindings
  for (const url of urls) {
    if (!next.some(binding => sameChangeRequestUrl(binding.url, url))) next = [...next, { url, origin, dismissed: false }]
  }
  return next
}

/** Move each reported branch to the end with the reporting event's sequence number. */
function recordPushes(pushes: readonly PushedBranch[], pushed: readonly PushedRef[], seq: SessionSeq): readonly PushedBranch[] {
  if (pushed.length === 0) return pushes
  const kept = pushes.filter(entry => !pushed.some(ref => ref.remote === entry.remote && ref.branch === entry.branch))
  return [...kept, ...pushed.map(ref => ({ remote: ref.remote, branch: ref.branch, seq }))]
}
