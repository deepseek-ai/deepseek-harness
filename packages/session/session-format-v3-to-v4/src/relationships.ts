/** Mandatory native V4 relationships; incomplete tails retain their open transactions. */

import { isDeepStrictEqual } from 'node:util'
import { SessionFormatError, isSessionFormatJsonObject, sessionFormatCount } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatEvent, SessionFormatJsonObject, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'

const SURFACE_TYPES = new Set(['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result'])
const STEP_EVENT_TYPES = new Set(['system/message', 'developer/message', 'assistant/attempt'])
const RELATIONSHIP_TYPES = new Set([
  ...SURFACE_TYPES, ...STEP_EVENT_TYPES, 'turn/start', 'turn/end', 'step/start', 'step/end',
  'tool/call', 'request/header', 'request/context', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch',
  'llm/retry', 'llm/retry-started', 'session/title', 'session/title-llm-request', 'command/run',
  'command/done', 'compaction/start', 'compaction/summary', 'compaction/end', 'compaction/prune', 'session/end-seed',
])

function record(value: SessionFormatJsonValue | undefined, subject: string): SessionFormatJsonObject {
  if (!isSessionFormatJsonObject(value)) throw new SessionFormatError(`${subject} requires an object`)
  return value
}

function text(value: SessionFormatJsonValue | undefined, subject: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new SessionFormatError(`${subject} requires a nonempty string`)
  return value
}

function array(value: SessionFormatJsonValue | undefined, subject: string): readonly SessionFormatJsonValue[] {
  if (!Array.isArray(value)) throw new SessionFormatError(`${subject} requires an array`)
  return value as readonly SessionFormatJsonValue[]
}

function earlier(value: SessionFormatJsonValue | undefined, seq: number, subject: string): number {
  const coordinate = sessionFormatCount(value, subject)
  if (coordinate >= seq) throw new SessionFormatError(`${subject} must name an earlier event`)
  return coordinate
}

interface ToolState {
  readonly name: SessionFormatJsonValue | undefined
  readonly arguments: SessionFormatJsonValue | undefined
  started: boolean
}

interface Compaction {
  readonly id: string
  readonly command: SessionFormatJsonValue | undefined
  readonly turn: number | null
  readonly seq: number
  summarized: boolean
}

/** One native artifact's lifecycle state; no state survives between reads. */
class Relationships {
  turn: number | null = null
  step: number | null = null
  nextTurn = 1
  nextStep = 1
  provider: SessionFormatJsonValue | undefined
  surface: number[] = []
  protectedHead: number | undefined
  compaction: Compaction | undefined
  readonly tools = new Map<string, ToolState>()
  readonly dispatches = new Map<string, { data: SessionFormatJsonObject; settled: boolean }>()
  readonly retries: SessionFormatJsonObject[] = []
  readonly startedRetries = new Set<string>()
  readonly commands = new Set<string>()
  readonly orphanCompactions = new Set<number>()

  constructor(readonly artifact: SessionFormatArtifact, readonly knownEventTypes: ReadonlySet<string>) {
    let start: number | undefined
    for (const event of artifact.events) {
      if (!knownEventTypes.has(event.type)) continue
      if (event.type === 'compaction/start') start = event.seq
      if (event.type === 'compaction/end') start = undefined
      if (event.type === 'session/end-seed') {
        if (start !== undefined) this.orphanCompactions.add(start)
        start = undefined
      }
    }
  }

  requireTurn(type: string): void {
    if (this.turn === null) throw new SessionFormatError(`${type} is outside an open turn`)
  }

  requireStep(event: SessionFormatEvent, data: SessionFormatJsonObject): void {
    if (this.turn === null || this.step === null || data['turn'] !== this.turn || data['step'] !== this.step) {
      throw new SessionFormatError(`${event.type} does not match an open turn and step`)
    }
  }

  closeTools(type: string): void {
    if (this.tools.size !== 0) throw new SessionFormatError(`${type} leaves unresolved tool call ${String(this.tools.keys().next().value)}`)
    this.tools.clear()
  }

  developer(event: SessionFormatEvent, data: SessionFormatJsonObject): void {
    if (data['headerSeq'] === undefined) return
    const headerSeq = earlier(data['headerSeq'], event.seq, 'developer/message headerSeq')
    const headerEvent = this.artifact.events[headerSeq]
    if (headerEvent?.type !== 'request/header') {
      throw new SessionFormatError('developer/message headerSeq must reference an earlier request/header')
    }
    if (!this.knownEventTypes.has(headerEvent.type)) {
      throw new SessionFormatError('developer/message headerSeq must reference a known request/header')
    }
    const tools = record(record(headerEvent.data, 'request/header data')['header'], 'request header')['tools']
    const content = array(record(data['message'], 'developer message')['content'], 'developer content')
    for (const value of content) {
      if (!isSessionFormatJsonObject(value) || value['type'] !== 'tool-addition') continue
      const toolName = value['toolName'] as string
      const definitions = Array.isArray(tools)
        ? tools.filter(tool => isSessionFormatJsonObject(tool) && tool['name'] === toolName)
        : []
      if (definitions.length !== 1) {
        throw new SessionFormatError(`developer/message tool-addition "${toolName}" must name exactly one tool in headerSeq ${headerSeq}`)
      }
      const definition = definitions[0] as SessionFormatJsonObject
      if (typeof definition['description'] !== 'string' || !isSessionFormatJsonObject(definition['parameters'])) {
        throw new SessionFormatError(`developer/message tool-addition "${toolName}" requires a complete tool definition in headerSeq ${headerSeq}`)
      }
    }
  }

  foldSurface(event: SessionFormatEvent): void {
    if (!SURFACE_TYPES.has(event.type)) return
    if (event.type === 'system/message' && this.surface.length > 0 && this.protectedHead === undefined) {
      throw new SessionFormatError('system/message requires a protected first surface head')
    }
    if (event['surfaceOp'] === 'append') {
      if (event.type === 'system/message' && this.surface.length === 0) this.protectedHead = event.seq
      this.surface.push(event.seq)
      return
    }
    const operation = record(event['surfaceOp'], `${event.type} surfaceOp`)
    const first = this.surface.indexOf(earlier(operation['startSeq'], event.seq, 'replacement start'))
    const last = this.surface.indexOf(earlier(operation['endSeq'], event.seq, 'replacement end'))
    if (first < 0 || last < first) throw new SessionFormatError(`${event.type} replacement range is not on the current surface`)
    const removed = this.surface.slice(first, last + 1)
    const sources = array(event['sourceEventSeqs'], 'replacement sourceEventSeqs')
    if (removed.some(seq => !sources.includes(seq))) throw new SessionFormatError('replacement sourceEventSeqs omit a shadowed surface node')
    if (this.protectedHead !== undefined && removed.includes(this.protectedHead)) {
      if (event.type !== 'system/message' || removed.length !== 1) throw new SessionFormatError('surface replacement cannot shadow the protected system head')
      this.protectedHead = event.seq
    }
    this.surface.splice(first, removed.length, event.seq)
  }

  tool(event: SessionFormatEvent, data: SessionFormatJsonObject): void {
    if (event.type === 'tool/result' && event['surfaceOp'] !== 'append') {
      this.requireTurn(event.type)
      return
    }
    this.requireStep(event, data)
    if (event.type === 'assistant/message') {
      const message = record(data['message'], 'assistant message')
      for (const value of array(message['content'], 'assistant content')) {
        const block = record(value, 'assistant content block')
        if (block['type'] !== 'tool-call') continue
        const id = text(block['id'], 'tool call id')
        if (this.tools.has(id)) throw new SessionFormatError(`assistant/message repeats advertised tool call ${id}`)
        this.tools.set(id, { name: block['name'], arguments: block['arguments'], started: false })
      }
      return
    }
    const message = event.type === 'tool/result' ? record(data['message'], 'tool result message') : undefined
    const id = text(message === undefined ? data['callId'] : message['toolCallId'], 'tool call id')
    const pending = this.tools.get(id)
    if (pending === undefined) throw new SessionFormatError(`${event.type} ${id} has no advertised tool lifecycle`)
    if (message === undefined) {
      if (pending.started || pending.name !== data['name'] || pending.arguments !== data['arguments']) {
        throw new SessionFormatError(`tool/call ${id} does not match one advertised tool call`)
      }
      pending.started = true
    } else {
      if (!pending.started && !notStartedRepair(event, data, message, id)) {
        throw new SessionFormatError(`tool/result ${id} is not the exact TOOL_NOT_STARTED repair`)
      }
      this.tools.delete(id)
    }
  }

  dispatch(event: SessionFormatEvent, data: SessionFormatJsonObject): void {
    this.requireTurn(event.type)
    const id = text(data['subCallId'], 'PTC subCallId')
    const root = text(data['rootCallId'], 'PTC rootCallId')
    const parent = text(data['parentCallId'], 'PTC parentCallId')
    const existing = this.dispatches.get(id)
    if (existing !== undefined && existing.data['rootCallId'] !== root) throw new SessionFormatError('PTC dispatch changes its rootCallId')
    if (parent !== root && this.dispatches.get(parent)?.data['rootCallId'] !== root) throw new SessionFormatError('PTC parentCallId does not belong to rootCallId')
    if (event.type === 'tool/ptc-dispatch-start') {
      if (existing !== undefined) throw new SessionFormatError('PTC dispatch repeats subCallId')
      this.dispatches.set(id, { data, settled: false })
      return
    }
    if (existing === undefined || existing.settled) throw new SessionFormatError('PTC dispatch has no unique start')
    if (['rootCallId', 'parentCallId', 'name', 'arguments'].some(key => !isDeepStrictEqual(existing.data[key], data[key]))) {
      throw new SessionFormatError('PTC dispatch does not match its start')
    }
    existing.settled = true
  }

  retry(event: SessionFormatEvent, data: SessionFormatJsonObject): void {
    const id = text(data['retryId'], 'retryId')
    const attempt = sessionFormatCount(data['retry'], 'retry')
    if (event.type === 'llm/retry-started') {
      const scheduled = this.retries.find(item => item['retryId'] === id && item['retry'] === attempt)
      if (scheduled === undefined) throw new SessionFormatError('llm/retry-started pairs no prior scheduled attempt')
      if (scheduled['turn'] !== data['turn'] || scheduled['step'] !== data['step']) throw new SessionFormatError('llm/retry-started changes scheduled coordinates')
      const key = JSON.stringify([id, attempt])
      if (this.startedRetries.has(key)) throw new SessionFormatError('llm/retry-started repeats one scheduled attempt')
      this.startedRetries.add(key)
      return
    }
    if (this.turn === null || data['turn'] !== this.turn || data['step'] !== (this.step ?? this.nextStep - 1)) {
      throw new SessionFormatError('llm/retry does not match the current turn and step')
    }
    if (data['provider'] !== this.provider) throw new SessionFormatError('llm/retry provider does not match the open request/header')
    const prior = this.retries.findLast(item => ['turn', 'step', 'provider', 'policyKey'].every(key => item[key] === data[key]))
    if (attempt !== (prior === undefined ? 1 : sessionFormatCount(prior['retry'], 'prior retry') + 1)) throw new SessionFormatError('llm/retry skips its policy attempt sequence')
    if (prior === undefined ? this.retries.some(item => item['retryId'] === id) : prior['retryId'] !== id) {
      throw new SessionFormatError('llm/retry must keep one retryId per policy chain')
    }
    this.retries.push(data)
  }

  compact(event: SessionFormatEvent, data: SessionFormatJsonObject): void {
    if (event.type === 'compaction/prune' || event.type === 'compaction/summary') this.span(event, data)
    if (event.type === 'compaction/prune') return
    if (event.type === 'compaction/start') {
      if (this.compaction !== undefined) throw new SessionFormatError('compaction/start overlaps an open compaction')
      const owner = data['turn'] === null ? null : sessionFormatCount(data['turn'], 'compaction turn')
      if (owner !== this.turn) throw new SessionFormatError('compaction/start does not match the open turn')
      this.compaction = { id: text(data['compactionId'], 'compactionId'), command: data['sourceCommandId'], turn: owner, seq: event.seq, summarized: false }
      return
    }
    const current = this.compactionOwner(data, event.type)
    if (current.turn !== this.turn) throw new SessionFormatError(`${event.type} does not match the open turn`)
    if (event.type === 'compaction/summary') {
      if (current.summarized) throw new SessionFormatError('compaction/summary repeats')
      current.summarized = true
    } else {
      if (data['turn'] !== current.turn) throw new SessionFormatError('compaction/end changes its owner turn')
      if (data['error'] === undefined && !current.summarized) throw new SessionFormatError('successful compaction/end requires one summary')
      this.compaction = undefined
    }
  }

  compactionOwner(data: SessionFormatJsonObject, subject: string): Compaction {
    if (this.compaction === undefined || this.compaction.id !== data['compactionId'] || this.compaction.command !== data['sourceCommandId']) {
      throw new SessionFormatError(`${subject} has no matching compaction/start`)
    }
    return this.compaction
  }

  span(event: SessionFormatEvent, data: SessionFormatJsonObject): void {
    const range = record(data['shadowedRange'], 'compaction shadowedRange')
    const start = this.surface.indexOf(earlier(range['start'], event.seq, 'compaction range start'))
    const end = this.surface.indexOf(earlier(range['end'], event.seq, 'compaction range end'))
    const seqs = array(data['shadowedSeqs'], 'compaction shadowedSeqs')
    if (start < 0 || end < start || !isDeepStrictEqual(this.surface.slice(start, end + 1), seqs)) {
      throw new SessionFormatError(`${event.type} shadowedSeqs do not name an exact current surface span`)
    }
    if (this.protectedHead !== undefined && seqs.includes(this.protectedHead)) throw new SessionFormatError('compaction cannot shadow the protected system head')
  }

  accept(event: SessionFormatEvent): void {
    if (!this.knownEventTypes.has(event.type) || !RELATIONSHIP_TYPES.has(event.type)) return
    const data = record(event.data, event.type)
    if (STEP_EVENT_TYPES.has(event.type)) this.requireStep(event, data)
    if (event.type.startsWith('turn/') && this.compaction !== undefined && !this.orphanCompactions.has(this.compaction.seq)) {
      throw new SessionFormatError(`${event.type} crosses an open compaction`)
    }
    this.foldSurface(event)
    switch (event.type) {
      case 'turn/start':
        if (this.turn !== null || data['turn'] !== this.nextTurn) throw new SessionFormatError('turn/start does not open the expected turn')
        this.turn = this.nextTurn
        this.nextStep = 1
        this.tools.clear()
        break
      case 'turn/end':
        if (this.turn === null || data['turn'] !== this.turn || this.step !== null) throw new SessionFormatError('turn/end does not match the open turn with no open step')
        this.closeTools(event.type)
        this.turn = null
        this.nextTurn += 1
        break
      case 'step/start':
        if (this.turn === null || data['turn'] !== this.turn || this.step !== null || data['step'] !== this.nextStep) throw new SessionFormatError('step/start does not match the open turn and next step')
        this.step = this.nextStep
        break
      case 'step/end':
        this.requireStep(event, data)
        this.closeTools(event.type)
        this.step = null
        this.nextStep += 1
        break
      case 'assistant/message': case 'tool/call': case 'tool/result': this.tool(event, data); break
      case 'developer/message': this.developer(event, data); break
      case 'request/header':
        this.requireTurn(event.type)
        this.provider = record(record(data['header'], 'request header')['config'], 'request config')['provider']
        break
      case 'request/context': this.requireTurn(event.type); break
      case 'tool/ptc-dispatch-start': case 'tool/ptc-dispatch': this.dispatch(event, data); break
      case 'llm/retry': case 'llm/retry-started': this.retry(event, data); break
      case 'session/title': case 'session/title-llm-request': titleSources(this.artifact.events, event, data, this.knownEventTypes); break
      case 'command/run': {
        const id = text(data['commandId'], 'commandId')
        if (this.commands.has(id)) throw new SessionFormatError(`command/run repeats commandId ${id}`)
        this.commands.add(id)
        break
      }
      case 'command/done': {
        if (!this.commands.has(text(data['commandId'], 'commandId'))) throw new SessionFormatError('command/done has no prior command/run')
        if (data['sourceEventSeq'] !== undefined) {
          const source = this.artifact.events[earlier(data['sourceEventSeq'], event.seq, 'command sourceEventSeq')]
          if (data['kind'] !== 'success' || source?.type === 'command/run' || source?.type === 'command/done') throw new SessionFormatError('command/done has invalid sourceEventSeq')
        }
        break
      }
      case 'compaction/start': case 'compaction/summary': case 'compaction/end': case 'compaction/prune': this.compact(event, data); break
      case 'user/message': {
        const source = record(data['source'], 'user message source')
        if (event['surfaceOp'] !== 'append' && source['kind'] === 'compact-checkpoint') this.compactionOwner(source, 'compaction checkpoint')
        break
      }
      case 'session/end-seed': this.compaction = undefined; break
    }
  }
}

function notStartedRepair(
  event: SessionFormatEvent, data: SessionFormatJsonObject, message: SessionFormatJsonObject, callId: string,
): boolean {
  const error = record(data['error'], 'not-started error')
  if (error['name'] !== 'ToolNotStartedError' || error['code'] !== 'TOOL_NOT_STARTED' || message['isError'] !== true || event['sourceEventSeqs'] !== undefined) return false
  const id = text(message['id'], 'not-started message id')
  // Fork-specific fields and identity are checked by assertV4ForkResult before relationships.
  if (id.startsWith(`forked-tool-result-${callId}-`)) return true
  const prefix = `interrupted-tool-result-${callId}-`
  const suffix = id.slice(prefix.length)
  const content = array(message['content'], 'not-started content')
  const block = content[0]
  return id.startsWith(prefix) && /^(0|[1-9]\d*)$/.test(suffix) && Number.isSafeInteger(Number(suffix))
    && content.length === 1 && isSessionFormatJsonObject(block) && block['type'] === 'text'
    && block['text'] === 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.'
}

function titleSources(
  events: readonly SessionFormatEvent[], event: SessionFormatEvent, data: SessionFormatJsonObject, knownEventTypes: ReadonlySet<string>,
): void {
  const references = array(data['messageSeqs'], 'title messageSeqs')
  if (event.type === 'session/title' && (references.length === 0) !== (record(data['source'], 'title source')['kind'] === 'user')) {
    throw new SessionFormatError('session/title messageSeqs must be empty exactly for a user title')
  }
  const seen = new Set<number>()
  for (const value of references) {
    const seq = earlier(value, event.seq, 'title messageSeqs')
    const source = events[seq]
    if (seen.has(seq) || source?.type !== 'user/message' || !knownEventTypes.has(source.type) || record(record(source.data, 'title input')['source'], 'title input source')['kind'] !== 'user') {
      throw new SessionFormatError(`${event.type} messageSeqs must cite distinct earlier human user/message events`)
    }
    seen.add(seq)
  }
  if (event.type !== 'session/title-llm-request') return
  const messages = array(data['messages'], 'title messages')
  const message = record(messages[0], 'title message')
  const content = array(message['content'], 'title content')
  const block = content[0]
  if (references.length === 0 || messages.length !== 1 || message['role'] !== 'user'
    || record(message['source'], 'title source')['kind'] !== 'dsh-session-title-llm'
    || content.length !== 1 || !isSessionFormatJsonObject(block) || block['type'] !== 'text') {
    throw new SessionFormatError('session/title-llm-request messages do not represent messageSeqs')
  }
}

/**
 * Validate native V4 lifecycle and ownership facts without rewriting any event.
 * @param artifact - artifact whose V4 envelopes and messages have been admitted.
 * @param knownEventTypes - installed event types whose payloads this reader interprets.
 */
export function assertV4LifecycleRelationships(artifact: SessionFormatArtifact, knownEventTypes: ReadonlySet<string>): void {
  const state = new Relationships(artifact, knownEventTypes)
  for (const event of artifact.events) state.accept(event)
}
