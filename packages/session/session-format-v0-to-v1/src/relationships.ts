import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { SessionFormatError } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatEvent, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { releasedV0Record } from './validation-helpers.ts'
import { RELEASED_V0_EVENT_DISPOSITIONS } from './dispositions.ts'

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

interface CompactionState {
  readonly id: string
  readonly sourceCommandId?: string
  readonly turn: number | null
  readonly startSeq: number
  readonly summarized: boolean
}

interface PtcStart {
  readonly root: string
  readonly parent: string
  readonly name: string
  readonly arguments: SessionFormatJsonValue
  settled: boolean
}

interface ToolLifecycle {
  readonly name: string
  readonly arguments: string
  state: 'advertised' | 'started'
}

/** Relationship roles added by a later format while reusing the released validator. */
export interface ReleasedRelationshipExtensions {
  /** Event types that must occur inside the current open step. */
  readonly stepEvents?: ReadonlySet<string>
  /** Title-request model input was source-validated and preserved across sequence remapping. */
  readonly preservedSourceTitleRequestText?: true
  /** Admit the released resume pattern whose next-turn inbox insert omitted the prior turn/end. */
  readonly legacyInterruptedTurnRestart?: true
}

/**
 * Validate cross-event relationships required to construct one current Session safely.
 * @param artifact - complete normalized v0 or exact current v1 artifact.
 * @param extensions - later-generation event roles interpreted by the calling format owner.
 */
export function assertReleasedArtifactRelationships(
  artifact: SessionFormatArtifact,
  extensions: ReleasedRelationshipExtensions = {},
): void {
  let openTurn: number | null = null
  let openStep: number | null = null
  let openStepProvider: string | undefined
  let nextTurn = 1
  let nextStep = 1
  let surface: number[] = []
  let openCompaction: CompactionState | undefined
  const staleCompactionStarts = inheritedOrphanCompactionStarts(artifact.events)
  const retries: SessionFormatEvent[] = []
  const retryStarts = new Set<string>()
  const ptcRoots = new Map<string, string>()
  const ptcStarts = new Map<string, PtcStart>()
  const toolLifecycles = new Map<string, ToolLifecycle>()
  const commandRuns = new Set<string>()

  for (const event of artifact.events) {
    const extensionStepEvent = extensions.stepEvents?.has(event.type) === true
    if (RELEASED_V0_EVENT_DISPOSITIONS[event.type] === undefined && !extensionStepEvent) continue
    const data = releasedV0Record(event.data, `${event.type} ${event.seq} data`)
    if (SURFACE_TYPES.has(event.type)) surface = applySurface(surface, event)
    if ((event.type === 'turn/start' || event.type === 'turn/end')
      && openCompaction !== undefined && !staleCompactionStarts.has(openCompaction.startSeq)) {
      throw new SessionFormatError(`${event.type} crosses an open compaction`)
    }
    if (extensionStepEvent) {
      requireOpenStep(event, data, openTurn, openStep)
      continue
    }

    switch (event.type) {
      case 'turn/start': {
        const previous = artifact.events[event.seq - 1]
        if (extensions.legacyInterruptedTurnRestart === true
          && openTurn !== null
          && openStep === null
          && data['turn'] === openTurn + 1
          && nextTurn === openTurn
          && previous?.type === 'agent/inbox/spliced') {
          const splice = releasedV0Record(previous.data, `agent/inbox/spliced ${previous.seq} data`)
          if (splice['target'] === 'next-turn'
            && Array.isArray(splice['inserted'])
            && splice['inserted'].length > 0) {
            openTurn = null
            nextTurn += 1
          }
        }
        if (openTurn !== null || data['turn'] !== nextTurn) {
          throw new SessionFormatError(`turn/start ${JSON.stringify(data['turn'])} does not open expected turn ${nextTurn}`)
        }
        openTurn = data['turn']
        openStep = null
        toolLifecycles.clear()
        nextStep = 1
        break
      }
      case 'turn/end':
        if (openTurn !== data['turn']) {
          throw new SessionFormatError(`turn/end ${JSON.stringify(data['turn'])} has no matching open turn`)
        }
        assertNoUnresolvedTools(toolLifecycles, 'turn/end')
        if (openStep !== null) {
          throw new SessionFormatError(`turn/end ${JSON.stringify(data['turn'])} crosses an open step`)
        }
        openTurn = null
        nextTurn += 1
        break
      case 'step/start':
        if (openTurn !== data['turn'] || openStep !== null || data['step'] !== nextStep) {
          throw new SessionFormatError(`${event.type} does not match the open turn and next step`)
        }
        openStep = data['step']
        break
      case 'step/end':
        requireOpenStep(event, data, openTurn, openStep)
        assertNoUnresolvedTools(toolLifecycles, 'step/end')
        toolLifecycles.clear()
        openStep = null
        nextStep += 1
        break
      case 'assistant/chunk':
        requireOpenStep(event, data, openTurn, openStep)
        break
      case 'assistant/message': {
        requireOpenStep(event, data, openTurn, openStep)
        const message = releasedV0Record(data['message'], `assistant/message ${event.seq} message`)
        const content = message['content'] as readonly Record<string, SessionFormatJsonValue>[]
        for (const block of content) {
          if (block['type'] !== 'tool-call') continue
          const callId = block['id'] as string
          if (toolLifecycles.has(callId)) {
            throw new SessionFormatError(`assistant/message repeats advertised tool call ${callId}`)
          }
          toolLifecycles.set(callId, {
            name: block['name'] as string,
            arguments: block['arguments'] as string,
            state: 'advertised',
          })
        }
        break
      }
      case 'tool/call': {
        requireOpenStep(event, data, openTurn, openStep)
        const callId = data['callId'] as string
        const lifecycle = toolLifecycles.get(callId)
        if (lifecycle === undefined || lifecycle.state !== 'advertised'
          || lifecycle.name !== data['name'] || lifecycle.arguments !== data['arguments']) {
          throw new SessionFormatError(`tool/call ${callId} does not match one advertised tool call`)
        }
        lifecycle.state = 'started'
        break
      }
      case 'tool/result':
        if (event['surfaceOp'] === 'append') {
          requireOpenStep(event, data, openTurn, openStep)
          const message = releasedV0Record(data['message'], `tool/result ${event.seq} message`)
          const source = releasedV0Record(message['source'], `tool/result ${event.seq} source`)
          const callId = source['callId'] as string
          const content = message['content'] as readonly Record<string, SessionFormatJsonValue>[]
          const error = data['error'] === undefined ? undefined : releasedV0Record(data['error'], `tool/result ${event.seq} error`)
          const lifecycle = toolLifecycles.get(callId)
          if (lifecycle === undefined) {
            throw new SessionFormatError(`tool/result ${callId} has no advertised tool lifecycle`)
          }
          if (lifecycle.state === 'advertised' && !isExactToolNotStartedRepair(event, content, error)) {
            throw new SessionFormatError(`tool/result ${callId} is not the exact TOOL_NOT_STARTED repair`)
          }
          toolLifecycles.delete(callId)
        } else if (openTurn === null) {
          throw new SessionFormatError('tool/result replacement is outside an open turn')
        }
        break
      case 'request/header':
        if (openTurn === null) throw new SessionFormatError(`${event.type} is outside an open turn`)
        openStepProvider = (((data['header'] as Record<string, SessionFormatJsonValue>)['config'] as Record<string, SessionFormatJsonValue>)['provider']) as string
        break
      case 'request/context':
        if (openTurn === null) throw new SessionFormatError(`${event.type} is outside an open turn`)
        break
      case 'tool/code-dispatch-start':
      case 'tool/code-dispatch': {
        if (openTurn === null) throw new SessionFormatError(`${event.type} is outside an open turn`)
        const root = data['rootCallId'] as string
        const parent = data['parentCallId'] as string
        const child = data['subCallId'] as string
        const known = ptcRoots.get(child)
        if (known !== undefined && known !== root) throw new SessionFormatError(`${event.type} changes its rootCallId`)
        if (parent !== root && ptcRoots.get(parent) !== root) {
          throw new SessionFormatError(`${event.type} parentCallId does not belong to rootCallId`)
        }
        if (event.type === 'tool/code-dispatch-start') {
          if (ptcStarts.has(child)) throw new SessionFormatError('tool/code-dispatch-start repeats subCallId')
          ptcStarts.set(child, {
            root,
            parent,
            name: data['name'] as string,
            arguments: data['arguments'] as SessionFormatJsonValue,
            settled: false,
          })
        } else {
          const start = ptcStarts.get(child)
          if (start === undefined || start.settled) throw new SessionFormatError('tool/code-dispatch has no unique start')
          if (start.root !== root || start.parent !== parent || start.name !== data['name']
            || !deepEqualJson(start.arguments, data['arguments'])) {
            throw new SessionFormatError('tool/code-dispatch does not match its start')
          }
          start.settled = true
        }
        ptcRoots.set(child, root)
        break
      }
      case 'llm/retry':
        if (openTurn !== data['turn']
          || data['step'] !== (openStep ?? nextStep - 1)
          || openTurn === null) {
          throw new SessionFormatError('llm/retry does not match the current turn and step')
        }
        if (data['provider'] !== openStepProvider) {
          throw new SessionFormatError('llm/retry provider does not match the open request/header')
        }
        assertRetryChain(retries, data)
        retries.push(event)
        break
      case 'llm/retry-started': {
        const scheduled = retries.find((candidate) => {
          const prior = candidate.data as Record<string, SessionFormatJsonValue>
          return prior['retryId'] === data['retryId'] && prior['retry'] === data['retry']
        })
        if (scheduled === undefined) throw new SessionFormatError('llm/retry-started pairs no prior scheduled attempt')
        const prior = scheduled.data as Record<string, SessionFormatJsonValue>
        if (prior['turn'] !== data['turn'] || prior['step'] !== data['step']) {
          throw new SessionFormatError('llm/retry-started does not match its scheduled turn and step')
        }
        const key = `${JSON.stringify(data['retryId'])}\0${JSON.stringify(data['retry'])}`
        if (retryStarts.has(key)) throw new SessionFormatError('llm/retry-started repeats one scheduled attempt')
        retryStarts.add(key)
        break
      }
      case 'session/title':
      case 'session/title-llm-request':
        assertTitleSources(
          artifact.events,
          event,
          data,
          extensions.preservedSourceTitleRequestText !== true,
        )
        break
      case 'command/run': {
        const id = data['commandId'] as string
        if (commandRuns.has(id)) throw new SessionFormatError(`command/run repeats commandId ${id}`)
        commandRuns.add(id)
        break
      }
      case 'command/done': {
        const id = data['commandId'] as string
        if (!commandRuns.has(id)) throw new SessionFormatError(`command/done ${id} has no prior command/run`)
        const sourceSeq = data['sourceEventSeq']
        if (sourceSeq !== undefined) {
          const source = artifact.events[sourceSeq as number]
          if (data['kind'] !== 'success' || source?.type === 'command/run' || source?.type === 'command/done') {
            throw new SessionFormatError(`command/done ${id} has invalid sourceEventSeq`)
          }
        }
        break
      }
      case 'session-log-deepseek/delivery-accepted': {
        const acceptedVersion = data['sessionFormatVersion'] ?? 0
        if (acceptedVersion === artifact.header.version) {
          const inherited = artifact.header.parentSession !== undefined && event.seq < artifact.inheritedEventCount
          if (!inherited && data['sessionId'] !== artifact.header.id) {
            throw new SessionFormatError('current-generation delivery marker names the wrong Session')
          }
        }
        break
      }
      case 'compaction/start':
        if (openCompaction !== undefined) throw new SessionFormatError('compaction/start overlaps an open compaction')
        assertCompactionTurn(data['turn'] as number | null, openTurn, 'compaction/start')
        openCompaction = {
          id: data['compactionId'] as string,
          ...(data['sourceCommandId'] === undefined ? {} : { sourceCommandId: data['sourceCommandId'] as string }),
          turn: data['turn'] as number | null,
          startSeq: event.seq,
          summarized: false,
        }
        break
      case 'compaction/summary':
        assertCompactionOwner(openCompaction, data, 'compaction/summary')
        assertCompactionTurn(openCompaction?.turn as number | null, openTurn, 'compaction/summary')
        if (openCompaction?.summarized === true) throw new SessionFormatError('compaction/summary repeats')
        assertCurrentSurfaceSpan(surface, data, 'compaction/summary')
        openCompaction = { ...(openCompaction as CompactionState), summarized: true }
        break
      case 'compaction/end':
        assertCompactionOwner(openCompaction, data, 'compaction/end')
        if (data['turn'] !== openCompaction?.turn) throw new SessionFormatError('compaction/end changes its owner turn')
        assertCompactionTurn(openCompaction?.turn as number | null, openTurn, 'compaction/end')
        if (data['error'] === undefined && openCompaction?.summarized !== true) {
          throw new SessionFormatError('successful compaction/end requires one summary')
        }
        openCompaction = undefined
        break
      case 'compaction/prune':
        assertCurrentSurfaceSpan(surface, data, 'compaction/prune')
        break
      case 'user/message': {
        const source = releasedV0Record(data['source'], `user/message ${event.seq} source`)
        if (event['surfaceOp'] !== 'append' && source['kind'] === 'plugin' && source['plugin'] === 'compact') {
          assertCompactionOwner(openCompaction, source, `compaction checkpoint at seq ${event.seq}`)
        }
        break
      }
      case 'session/end-seed':
        // An unmatched inherited transaction belongs to the ended source lifecycle.
        openCompaction = undefined
        break
    }
  }
}

function inheritedOrphanCompactionStarts(events: readonly SessionFormatEvent[]): ReadonlySet<number> {
  const stale = new Set<number>()
  let open: number | undefined
  for (const event of events) {
    if (event.type === 'compaction/start') open = event.seq
    else if (event.type === 'compaction/end') open = undefined
    else if (event.type === 'session/end-seed') {
      if (open !== undefined) stale.add(open)
      open = undefined
    }
  }
  return stale
}

function assertRetryChain(
  retries: readonly SessionFormatEvent[],
  data: Record<string, SessionFormatJsonValue>,
): void {
  const prior = [...retries].reverse().find((candidate) => {
    const value = candidate.data as Record<string, SessionFormatJsonValue>
    return value['turn'] === data['turn'] && value['step'] === data['step']
      && value['provider'] === data['provider'] && value['policyKey'] === data['policyKey']
  })
  const expected = ((prior?.data as Record<string, SessionFormatJsonValue> | undefined)?.['retry'] as number | undefined ?? 0) + 1
  if (data['retry'] !== expected) throw new SessionFormatError(`llm/retry must use retry ${expected}`)
  if (prior !== undefined
    && (prior.data as Record<string, SessionFormatJsonValue>)['retryId'] !== data['retryId']) {
    throw new SessionFormatError('llm/retry must preserve retryId across one policy chain')
  }
  if (prior === undefined && retries.some(candidate =>
    (candidate.data as Record<string, SessionFormatJsonValue>)['retryId'] === data['retryId'])) {
    throw new SessionFormatError(`llm/retry reuses retryId ${JSON.stringify(data['retryId'])} across policy chains`)
  }
}

function requireOpenStep(
  event: SessionFormatEvent,
  data: Record<string, SessionFormatJsonValue>,
  openTurn: number | null,
  openStep: number | null,
): void {
  if (data['turn'] !== openTurn || data['step'] !== openStep || openTurn === null || openStep === null) {
    throw new SessionFormatError(`${event.type} does not match an open turn and step`)
  }
}

function assertNoUnresolvedTools(lifecycles: ReadonlyMap<string, ToolLifecycle>, boundary: string): void {
  const unresolved = lifecycles.keys().next().value
  if (unresolved !== undefined) {
    throw new SessionFormatError(`${boundary} leaves unresolved tool call ${unresolved}`)
  }
}

function isExactToolNotStartedRepair(
  event: SessionFormatEvent,
  content: readonly Record<string, SessionFormatJsonValue>[],
  error: Record<string, SessionFormatJsonValue> | undefined,
): boolean {
  const data = event.data as Record<string, SessionFormatJsonValue>
  const message = data['message'] as Record<string, SessionFormatJsonValue>
  const source = message['source'] as Record<string, SessionFormatJsonValue>
  const callId = source['callId'] as string
  const block = content[0]
  const repairContent = block?.['content'] as readonly Record<string, SessionFormatJsonValue>[] | undefined
  return error?.['name'] === 'ToolNotStartedError'
    && error['code'] === 'TOOL_NOT_STARTED'
    && event['sourceEventSeqs'] === undefined
    && message['id'] === `interrupted-tool-result-${callId}-${event.seq}`
    && block?.['isError'] === true
    && repairContent?.length === 1
    && repairContent[0]?.['type'] === 'text'
    && repairContent[0]['text']
      === 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.'
}

function applySurface(surface: readonly number[], event: SessionFormatEvent): number[] {
  const operation = event['surfaceOp']
  if (operation === undefined) throw new SessionFormatError(`${event.type} requires a surfaceOp marker`)
  if (operation === 'append') return [...surface, event.seq]
  const replace = operation as { readonly start: number; readonly end: number }
  const start = surface.indexOf(replace.start)
  const end = surface.indexOf(replace.end)
  if (start < 0 || end < start) throw new SessionFormatError(`${event.type} replacement range is not on the current surface`)
  const shadowed = surface.slice(start, end + 1)
  const sources = new Set(Array.isArray(event['sourceEventSeqs']) ? event['sourceEventSeqs'] as readonly number[] : [])
  if (shadowed.some(seq => !sources.has(seq))) {
    throw new SessionFormatError(`${event.type} replacement sourceEventSeqs omit a shadowed surface node`)
  }
  return [...surface.slice(0, start), event.seq, ...surface.slice(end + 1)]
}

function assertTitleSources(
  events: readonly SessionFormatEvent[],
  event: SessionFormatEvent,
  data: Record<string, SessionFormatJsonValue>,
  validateFramedText: boolean,
): void {
  const seqs = data['messageSeqs'] as readonly number[]
  if (event.type === 'session/title') {
    const titleSource = releasedV0Record(data['source'], `session/title ${event.seq} source`)
    if ((seqs.length === 0) !== (titleSource['kind'] === 'user')) {
      throw new SessionFormatError(`session/title ${event.seq} messageSeqs must be empty exactly for a user title`)
    }
  }
  const selected: Array<{ readonly seq: number; readonly text: string }> = []
  for (const seq of seqs) {
    const source = events[seq]
    if (source?.type !== 'user/message') {
      throw new SessionFormatError(`${event.type} ${event.seq} messageSeqs must cite earlier human user/message events`)
    }
    const sourceData = releasedV0Record(source.data, `${source.type} ${seq} data`)
    const provenance = releasedV0Record(sourceData['source'], `${source.type} ${seq} source`)
    if (provenance['kind'] !== 'user') {
      throw new SessionFormatError(`${event.type} ${event.seq} messageSeqs must cite earlier human user/message events`)
    }
    const content = sourceData['content'] as readonly Record<string, SessionFormatJsonValue>[]
    selected.push({
      seq,
      text: content.flatMap(block => block['type'] === 'text' && typeof block['text'] === 'string' ? [block['text']] : []).join('\n'),
    })
  }
  if (event.type === 'session/title-llm-request') {
    const messages = data['messages'] as readonly Record<string, SessionFormatJsonValue>[]
    const expected = `Generate the session title from this JSON array of human messages:\n${JSON.stringify(selected)}`
    const message = messages[0]
    const content = message?.['content'] as readonly Record<string, SessionFormatJsonValue>[] | undefined
    const source = message === undefined ? undefined : releasedV0Record(message['source'], 'session/title-llm-request message source')
    if (messages.length !== 1 || message?.['role'] !== 'user' || content?.length !== 1
      || source?.['kind'] !== 'plugin' || source['plugin'] !== 'dsh-session-title-llm') {
      throw new SessionFormatError('session/title-llm-request messages do not represent messageSeqs')
    }
    const framed = content[0]
    if (framed === undefined || framed['type'] !== 'text'
      || validateFramedText && framed['text'] !== expected) {
      throw new SessionFormatError('session/title-llm-request messages do not represent messageSeqs')
    }
  }
}

function assertCompactionOwner(
  open: CompactionState | undefined,
  data: Record<string, SessionFormatJsonValue>,
  type: string,
): void {
  if (open === undefined || data['compactionId'] !== open.id || data['sourceCommandId'] !== open.sourceCommandId) {
    throw new SessionFormatError(`${type} has no matching compaction/start`)
  }
}

function assertCompactionTurn(owner: number | null, openTurn: number | null, type: string): void {
  if (owner === null ? openTurn !== null : owner !== openTurn) {
    throw new SessionFormatError(`${type} does not match the open turn`)
  }
}

function assertCurrentSurfaceSpan(
  surface: readonly number[],
  data: Record<string, SessionFormatJsonValue>,
  type: string,
): void {
  const range = data['shadowedRange'] as { readonly start: number; readonly end: number }
  const seqs = data['shadowedSeqs'] as readonly number[]
  const start = surface.indexOf(range.start)
  const end = surface.indexOf(range.end)
  const expected = start < 0 || end < start ? [] : surface.slice(start, end + 1)
  if (expected.length !== seqs.length || expected.some((seq, index) => seq !== seqs[index])) {
    throw new SessionFormatError(`${type} shadowedSeqs do not name an exact current surface span`)
  }
}
