import { SessionFormatError, sessionFormatCount, sessionFormatSafeInteger } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatEvent,
  SessionFormatJsonValue,
} from '@deepseek-ai/dsh-session-format'
import { assertReleasedV0Keys, releasedV0Record } from './validation-helpers.ts'

type JsonRecord = Record<string, SessionFormatJsonValue>

/**
 * Validate nested released payload semantics for one known event.
 * @param event - known event with exact top-level members.
 * @param version - source or current payload generation.
 */
export function assertReleasedPayloadSemantics(event: SessionFormatEvent, version: number): void {
  const data = releasedV0Record(event.data, `${event.type} ${event.seq} data`)
  const label = `${event.type} ${event.seq}`
  switch (event.type) {
    case 'agent-preset/selected':
      stringValue(data['agentPreset'], `${label} agentPreset`)
      return
    case 'agent/inbox/spliced':
      literalValue(data['target'], ['next-turn', 'next-step'], `${label} target`)
      countValue(data['start'], `${label} start`)
      if (data['removedCount'] !== undefined) countValue(data['removedCount'], `${label} removedCount`)
      arrayValue(data['inserted'], `${label} inserted`, (value) => {
        messageValue(value, `${label} inserted message`, version, 'user')
      })
      if (data['outcome'] !== undefined) literalValue(data['outcome'], ['canceled'], `${label} outcome`)
      return
    case 'approval/asked':
      nonEmptyString(data['id'], `${label} id`)
      nonEmptyString(data['toolName'], `${label} toolName`)
      if (data['callId'] !== undefined) nonEmptyString(data['callId'], `${label} callId`)
      if (data['reason'] !== undefined) stringValue(data['reason'], `${label} reason`)
      return
    case 'approval/decided':
      nonEmptyString(data['id'], `${label} id`)
      literalValue(data['outcome'], ['allowed-once', 'rejected', 'cancelled', 'unavailable'], `${label} outcome`)
      return
    case 'approval/policy':
      literalValue(data['policy'], ['ask', 'never'], `${label} policy`)
      if (data['source'] !== undefined) literalValue(data['source'], ['delegation'], `${label} source`)
      return
    case 'assistant/chunk':
      coordinatePair(data, label)
      streamChunkValue(data['chunk'], `${label} chunk`)
      return
    case 'assistant/message':
      coordinatePair(data, label)
      messageValue(data['message'], `${label} message`, version, 'assistant')
      if (data['usage'] !== undefined) tokenUsageValue(data['usage'], `${label} usage`)
      if (data['interrupted'] !== undefined) literalValue(data['interrupted'], [true], `${label} interrupted`)
      return
    case 'command/done':
      nonEmptyString(data['commandId'], `${label} commandId`)
      literalValue(data['kind'], ['success', 'error'], `${label} kind`)
      if (data['text'] !== undefined) stringValue(data['text'], `${label} text`)
      if (data['sourceEventSeq'] !== undefined) earlierSeq(data['sourceEventSeq'], event.seq, `${label} sourceEventSeq`)
      return
    case 'command/run': {
      nonEmptyString(data['commandId'], `${label} commandId`)
      nonEmptyString(data['name'], `${label} name`)
      if (data['args'] !== undefined) stringValue(data['args'], `${label} args`)
      const source = exactRecord(data['source'], `${label} source`, ['kind'])
      literalValue(source['kind'], ['user'], `${label} source kind`)
      return
    }
    case 'compaction/start':
    case 'compaction/end':
      nonEmptyString(data['compactionId'], `${label} compactionId`)
      if (data['sourceCommandId'] !== undefined) nonEmptyString(data['sourceCommandId'], `${label} sourceCommandId`)
      nullableValue(data['turn'], `${label} turn`, countValue)
      if (data['error'] !== undefined) stringValue(data['error'], `${label} error`)
      return
    case 'compaction/prune':
      shadowedValue(data, event.seq, label)
      return
    case 'compaction/summary':
      if (data['llmStreamCall'] === true && data['rawOutput'] === undefined) {
        throw new SessionFormatError(`${label} llmStreamCall requires rawOutput`)
      }
      nonEmptyString(data['compactionId'], `${label} compactionId`)
      if (data['sourceCommandId'] !== undefined) nonEmptyString(data['sourceCommandId'], `${label} sourceCommandId`)
      contentBlocksValue(data['summary'], `${label} summary`, version)
      shadowedValue(data, event.seq, label)
      nonEmptyString(data['provider'], `${label} provider`)
      nonEmptyString(data['model'], `${label} model`)
      if (data['maxTokens'] !== undefined) countValue(data['maxTokens'], `${label} maxTokens`)
      if (data['usage'] !== undefined) tokenUsageValue(data['usage'], `${label} usage`)
      if (data['rawOutput'] !== undefined) contentBlocksValue(data['rawOutput'], `${label} rawOutput`, version)
      if (data['llmStreamCall'] !== undefined) literalValue(data['llmStreamCall'], [true], `${label} llmStreamCall`)
      return
    case 'feedback/record':
      nonEmptyString(data['text'], `${label} text`)
      return
    case 'goal/change':
      goalChangeValue(data, label)
      return
    case 'hook/invoked':
      countValue(data['turn'], `${label} turn`)
      nonEmptyString(data['point'], `${label} point`)
      literalValue(data['dialect'], ['claude-code', 'codex'], `${label} dialect`)
      if (data['matcher'] !== undefined) stringValue(data['matcher'], `${label} matcher`)
      nonEmptyString(data['handlerId'], `${label} handlerId`)
      return
    case 'hook/result':
      countValue(data['turn'], `${label} turn`)
      nonEmptyString(data['point'], `${label} point`)
      nonEmptyString(data['handlerId'], `${label} handlerId`)
      nonEmptyString(data['decision'], `${label} decision`)
      if (data['exitCode'] !== undefined) safeIntegerValue(data['exitCode'], `${label} exitCode`)
      if (data['stderrSummary'] !== undefined) stringValue(data['stderrSummary'], `${label} stderrSummary`)
      if (finiteNumberValue(data['durationMs'], `${label} durationMs`) < 0) {
        throw new SessionFormatError(`${label} durationMs must be non-negative`)
      }
      return
    case 'llm/retry':
      nonEmptyString(data['retryId'], `${label} retryId`)
      coordinatePair(data, label)
      nonEmptyString(data['provider'], `${label} provider`)
      literalValue(data['mode'], ['normal', 'always'], `${label} mode`)
      nonEmptyString(data['policyKey'], `${label} policyKey`)
      positiveIntegerValue(data['retry'], `${label} retry`)
      if (data['mode'] === 'normal') {
        const maxRetries = positiveIntegerValue(data['maxRetries'], `${label} maxRetries`)
        if ((data['retry'] as number) > maxRetries) throw new SessionFormatError(`${label} retry exceeds maxRetries`)
      } else if (data['maxRetries'] !== undefined) {
        throw new SessionFormatError(`${label} always mode must omit maxRetries`)
      }
      const delayMs = finiteNumberValue(data['delayMs'], `${label} delayMs`)
      if (delayMs < 0) throw new SessionFormatError(`${label} delayMs must be non-negative`)
      if (delayMs > 2_147_483_647) {
        throw new SessionFormatError(`${label} delayMs exceeds the timer range`)
      }
      llmFailureValue(data['failure'], `${label} failure`)
      return
    case 'llm/retry-started':
      nonEmptyString(data['retryId'], `${label} retryId`)
      coordinatePair(data, label)
      positiveIntegerValue(data['retry'], `${label} retry`)
      return
    case 'model/selection':
      nonEmptyString(data['provider'], `${label} provider`)
      nonEmptyString(data['model'], `${label} model`)
      if (data['reasoningEffort'] !== undefined) nonEmptyString(data['reasoningEffort'], `${label} reasoningEffort`)
      return
    case 'permission/preset':
      nonEmptyString(data['preset'], `${label} preset`)
      return
    case 'plan/mode':
      booleanValue(data['active'], `${label} active`)
      return
    case 'request/context':
      nonEmptyString(data['provider'], `${label} provider`)
      nonEmptyString(data['model'], `${label} model`)
      if (data['contextWindow'] !== undefined) positiveIntegerValue(data['contextWindow'], `${label} contextWindow`)
      return
    case 'request/header':
      requestHeaderValue(data['header'], `${label} header`)
      literalValue(data['reason'], ['initial', 'resume', 'change', 'series'], `${label} reason`)
      if (data['startsSeries'] !== undefined) literalValue(data['startsSeries'], [true], `${label} startsSeries`)
      return
    case 'sandbox/mode':
      literalValue(data['mode'], ['read-only', 'workspace-write', 'danger-full-access'], `${label} mode`)
      if (data['source'] !== undefined) literalValue(data['source'], ['delegation'], `${label} source`)
      return
    case 'schedule/change':
      scheduleChangeValue(data, label)
      return
    case 'session-log-deepseek/delivery-accepted':
      {
        const acceptedVersion = data['sessionFormatVersion'] === undefined
          ? 0
          : countValue(data['sessionFormatVersion'], `${label} sessionFormatVersion`)
        if (acceptedVersion !== version) return
        nonEmptyString(data['sessionId'], `${label} sessionId`)
        earlierSeq(data['throughSeq'], event.seq, `${label} throughSeq`)
      }
      return
    case 'session/end-seed':
      return
    case 'session/title':
      nonEmptyString(data['title'], `${label} title`)
      seqArray(data['messageSeqs'], event.seq, `${label} messageSeqs`, false)
      titleSourceValue(data['source'], `${label} source`)
      return
    case 'session/title-llm-request':
      nonEmptyString(data['titleProvider'], `${label} titleProvider`)
      seqArray(data['messageSeqs'], event.seq, `${label} messageSeqs`, true)
      modelRouteValue(data['route'], `${label} route`)
      stringValue(data['system'], `${label} system`)
      arrayValue(data['messages'], `${label} messages`, (value) => {
        messageValue(value, `${label} message`, version)
      })
      positiveIntegerValue(data['maxTokens'], `${label} maxTokens`)
      return
    case 'step/end':
    case 'step/start':
      coordinatePair(data, label)
      return
    case 'subagent/descriptor':
      subagentDescriptorValue(data, label)
      return
    case 'subagent/model-selection-policy':
      allowedModelsValue(data['allowedModels'], `${label} allowedModels`)
      return
    case 'team/member':
      teamSelector(data, label)
      teamMemberValue(data['member'], `${label} member`)
      return
    case 'team/message/delivered':
      teamSelector(data, label)
      nonEmptyString(data['messageId'], `${label} messageId`)
      nonEmptyString(data['targetId'], `${label} targetId`)
      return
    case 'team/message/queued':
      teamSelector(data, label)
      teamMessageValue(data['message'], `${label} message`, version)
      return
    case 'team/task':
      teamSelector(data, label)
      teamTaskValue(data['task'], `${label} task`)
      return
    case 'todo/write':
      arrayValue(data['todos'], `${label} todos`, (value, itemLabel) => {
        const item = exactRecord(value, itemLabel, ['content', 'status'])
        stringValue(item['content'], `${itemLabel} content`)
        literalValue(item['status'], ['pending', 'in_progress', 'completed'], `${itemLabel} status`)
      })
      return
    case 'tool-workflow/agent-end':
      workflowIdentity(data, label)
      literalValue(data['outcome'], ['completed', 'failed', 'cancelled'], `${label} outcome`)
      return
    case 'tool-workflow/agent-start':
      workflowIdentity(data, label)
      stringValue(data['label'], `${label} label`)
      if (data['phase'] !== undefined) stringValue(data['phase'], `${label} phase`)
      nonEmptyString(data['childId'], `${label} childId`)
      return
    case 'tool-workflow/run-end':
      nonEmptyString(data['runId'], `${label} runId`)
      literalValue(data['stopReason'], ['completed', 'cancelled', 'error'], `${label} stopReason`)
      return
    case 'tool-workflow/run-start':
      nonEmptyString(data['runId'], `${label} runId`)
      nonEmptyString(data['name'], `${label} name`)
      return
    case 'tool/call':
      coordinatePair(data, label)
      nonEmptyString(data['callId'], `${label} callId`)
      nonEmptyString(data['name'], `${label} name`)
      stringValue(data['arguments'], `${label} arguments`)
      return
    case 'tool/code-dispatch':
    case 'tool/code-dispatch-start':
      nonEmptyString(data['rootCallId'], `${label} rootCallId`)
      nonEmptyString(data['parentCallId'], `${label} parentCallId`)
      nonEmptyString(data['subCallId'], `${label} subCallId`)
      nonEmptyString(data['name'], `${label} name`)
      if (event.type === 'tool/code-dispatch') {
        booleanValue(data['isError'], `${label} isError`)
        contentBlocksValue(data['content'], `${label} content`, version)
      }
      return
    case 'tool/result':
      coordinatePair(data, label)
      messageValue(data['message'], `${label} message`, version, 'tool')
      if (data['error'] !== undefined) {
        const error = exactRecord(data['error'], `${label} error`, ['name', 'code'])
        nonEmptyString(error['name'], `${label} error name`)
        nonEmptyString(error['code'], `${label} error code`)
      }
      return
    case 'turn/end':
      countValue(data['turn'], `${label} turn`)
      turnEndReasonValue(data['reason'], `${label} reason`)
      return
    case 'turn/start':
      countValue(data['turn'], `${label} turn`)
      return
    case 'user/message':
      messageValue(data, label, version, 'user')
      return
    case 'web/deepseek-search-llm-request':
      nonEmptyString(data['endpoint'], `${label} endpoint`)
      nonEmptyString(data['apiVersion'], `${label} apiVersion`)
      deepSeekSearchBodyValue(data['body'], `${label} body`)
      return
    /* v8 ignore next -- the frozen disposition rejects unknown types before semantic dispatch. */
    default:
      throw new SessionFormatError(`released payload validator is missing event ${JSON.stringify(event.type)}`)
  }
}

function exactRecord(
  value: SessionFormatJsonValue | undefined,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): JsonRecord {
  const record = releasedV0Record(value, label)
  assertReleasedV0Keys(record, required, optional, label)
  return record
}

function stringValue(value: SessionFormatJsonValue | undefined, label: string): asserts value is string {
  if (typeof value !== 'string') throw new SessionFormatError(`${label} must be a string`)
}

function nonEmptyString(value: SessionFormatJsonValue | undefined, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new SessionFormatError(`${label} must be a non-empty string`)
}

function booleanValue(value: SessionFormatJsonValue | undefined, label: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new SessionFormatError(`${label} must be a boolean`)
}

function safeIntegerValue(value: SessionFormatJsonValue | undefined, label: string): number {
  return sessionFormatSafeInteger(value, label)
}

function countValue(value: SessionFormatJsonValue | undefined, label: string): number {
  return sessionFormatCount(value, label)
}

function positiveIntegerValue(value: SessionFormatJsonValue | undefined, label: string): number {
  const result = countValue(value, label)
  if (result === 0) throw new SessionFormatError(`${label} must be positive`)
  return result
}

function finiteNumberValue(value: SessionFormatJsonValue | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)) {
    throw new SessionFormatError(`${label} must be a finite number`)
  }
  return value
}

function literalValue(
  value: SessionFormatJsonValue | undefined,
  allowed: readonly SessionFormatJsonValue[],
  label: string,
): void {
  if (!allowed.some(candidate => candidate === value)) {
    throw new SessionFormatError(`${label} must be one of ${allowed.map(String).join(', ')}`)
  }
}

function nullableValue(
  value: SessionFormatJsonValue | undefined,
  label: string,
  validate: (value: SessionFormatJsonValue | undefined, label: string) => unknown,
): void {
  if (value !== null) validate(value, label)
}

function arrayValue(
  value: SessionFormatJsonValue | undefined,
  label: string,
  validate: (value: SessionFormatJsonValue, label: string) => void,
): readonly SessionFormatJsonValue[] {
  if (!Array.isArray(value)) throw new SessionFormatError(`${label} must be an array`)
  const members = value as readonly SessionFormatJsonValue[]
  members.forEach((member, index) => {
    validate(member, `${label}[${index}]`)
  })
  return members
}

function coordinatePair(data: JsonRecord, label: string): void {
  countValue(data['turn'], `${label} turn`)
  countValue(data['step'], `${label} step`)
}

function earlierSeq(value: SessionFormatJsonValue | undefined, eventSeq: number, label: string): number {
  const seq = countValue(value, label)
  if (seq >= eventSeq) throw new SessionFormatError(`${label} must identify an earlier event`)
  return seq
}

function seqArray(
  value: SessionFormatJsonValue | undefined,
  eventSeq: number,
  label: string,
  requireNonEmpty: boolean,
): readonly SessionFormatJsonValue[] {
  const seen = new Set<number>()
  const values = arrayValue(value, label, (member, memberLabel) => {
    const seq = earlierSeq(member, eventSeq, memberLabel)
    if (seen.has(seq)) throw new SessionFormatError(`${label} repeats seq ${seq}`)
    seen.add(seq)
  })
  if (requireNonEmpty && values.length === 0) throw new SessionFormatError(`${label} must be non-empty`)
  return values
}

function llmFailureValue(value: SessionFormatJsonValue | undefined, label: string): void {
  const failure = exactRecord(value, label, ['message', 'code'], ['status', 'providerRetryAfterMs', 'requestId'])
  nonEmptyString(failure['message'], `${label} message`)
  nonEmptyString(failure['code'], `${label} code`)
  if (failure['status'] !== undefined) {
    const status = safeIntegerValue(failure['status'], `${label} status`)
    if (status < 100 || status > 599) throw new SessionFormatError(`${label} status must be 100 through 599`)
  }
  if (failure['providerRetryAfterMs'] !== undefined
    && finiteNumberValue(failure['providerRetryAfterMs'], `${label} providerRetryAfterMs`) <= 0) {
    throw new SessionFormatError(`${label} providerRetryAfterMs must be positive`)
  }
  if (failure['requestId'] !== undefined) nonEmptyString(failure['requestId'], `${label} requestId`)
}

function tokenUsageValue(value: SessionFormatJsonValue | undefined, label: string): void {
  const usage = exactRecord(
    value,
    label,
    ['inputTokens', 'outputTokens'],
    ['totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'],
  )
  for (const key of Object.keys(usage)) countValue(usage[key], `${label} ${key}`)
}

function contentBlocksValue(value: SessionFormatJsonValue | undefined, label: string, version: number): void {
  arrayValue(value, label, (member, memberLabel) => {
    contentBlockValue(member, memberLabel, version)
  })
}

function contentBlockValue(value: SessionFormatJsonValue, label: string, version: number): void {
  const block = releasedV0Record(value, label)
  switch (block['type']) {
    case 'text':
    case 'reasoning':
      assertReleasedV0Keys(block, ['type', 'text'], [], label)
      stringValue(block['text'], `${label} text`)
      return
    case 'image':
      assertReleasedV0Keys(block, ['type', 'attachment'], [], label)
      imageAttachmentValue(block['attachment'], `${label} attachment`)
      return
    case 'tool-call':
      assertReleasedV0Keys(block, ['type', 'id', 'name', 'arguments'], [], label)
      nonEmptyString(block['id'], `${label} id`)
      nonEmptyString(block['name'], `${label} name`)
      stringValue(block['arguments'], `${label} arguments`)
      return
    case 'tool-result':
      assertReleasedV0Keys(block, ['type', 'toolCallId', 'content'], ['isError'], label)
      nonEmptyString(block['toolCallId'], `${label} toolCallId`)
      contentBlocksValue(block['content'], `${label} content`, version)
      if (block['isError'] !== undefined) booleanValue(block['isError'], `${label} isError`)
      return
    default:
      nonEmptyString(block['type'], `${label} type`)
      return
  }
}

function imageAttachmentValue(value: SessionFormatJsonValue | undefined, label: string): void {
  const attachment = exactRecord(
    value,
    label,
    ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
    ['name', 'originalDimensions'],
  )
  nonEmptyString(attachment['attachmentId'], `${label} attachmentId`)
  literalValue(attachment['mediaType'], ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], `${label} mediaType`)
  countValue(attachment['bytes'], `${label} bytes`)
  positiveIntegerValue(attachment['width'], `${label} width`)
  positiveIntegerValue(attachment['height'], `${label} height`)
  if (attachment['name'] !== undefined) stringValue(attachment['name'], `${label} name`)
  if (attachment['originalDimensions'] !== undefined) {
    const dimensions = exactRecord(attachment['originalDimensions'], `${label} originalDimensions`, ['width', 'height'])
    positiveIntegerValue(dimensions['width'], `${label} original width`)
    positiveIntegerValue(dimensions['height'], `${label} original height`)
  }
}

function messageValue(
  value: SessionFormatJsonValue | undefined,
  label: string,
  version: number,
  expected?: 'user' | 'assistant' | 'tool',
): void {
  const message = exactRecord(value, label, ['id', 'role', 'content', 'source'])
  nonEmptyString(message['id'], `${label} id`)
  const role = expected === 'assistant' ? 'assistant' : expected === 'user' || expected === 'tool' ? 'user' : undefined
  if (role === undefined) literalValue(message['role'], ['system', 'user', 'assistant'], `${label} role`)
  else literalValue(message['role'], [role], `${label} role`)
  contentBlocksValue(message['content'], `${label} content`, version)
  messageSourceValue(message['source'], `${label} source`, version, expected)
  if (expected === 'tool') {
    const content = message['content']
    const block = Array.isArray(content) && content.length === 1
      ? releasedV0Record(content[0], `${label} tool result`)
      : undefined
    const source = releasedV0Record(message['source'], `${label} source`)
    if (block?.['type'] !== 'tool-result' || block['toolCallId'] !== source['callId']) {
      throw new SessionFormatError(`${label} must contain exactly one tool-result block`)
    }
  }
}

function messageSourceValue(
  value: SessionFormatJsonValue | undefined,
  label: string,
  version: number,
  expected?: 'user' | 'assistant' | 'tool',
): void {
  const source = releasedV0Record(value, label)
  if (expected === 'assistant' && source['kind'] !== 'model') throw new SessionFormatError(`${label} must be model source`)
  if (expected === 'tool' && source['kind'] !== 'tool') throw new SessionFormatError(`${label} must be tool source`)
  switch (source['kind']) {
    case 'user':
      assertReleasedV0Keys(source, ['kind'], ['rpcId', 'clientTimeZone'], label)
      if (source['rpcId'] !== undefined) nonEmptyString(source['rpcId'], `${label} rpcId`)
      if (source['clientTimeZone'] !== undefined) nonEmptyString(source['clientTimeZone'], `${label} clientTimeZone`)
      return
    case 'plugin':
      pluginSourceValue(source, label)
      return
    case 'model':
      assertReleasedV0Keys(source, ['kind', 'provider', 'model'], ['replayState'], label)
      nonEmptyString(source['provider'], `${label} provider`)
      nonEmptyString(source['model'], `${label} model`)
      return
    case 'tool':
      assertReleasedV0Keys(source, ['kind', 'callId'], [], label)
      nonEmptyString(source['callId'], `${label} callId`)
      return
    case 'agent-instructions':
      assertReleasedV0Keys(source, ['kind', 'form', 'changes'], ['baseline', 'baselineIdentity'], label)
      literalValue(source['form'], ['instructions'], `${label} form`)
      if (source['baseline'] !== undefined) literalValue(source['baseline'], [true], `${label} baseline`)
      if (source['baselineIdentity'] !== undefined) nonEmptyString(source['baselineIdentity'], `${label} baselineIdentity`)
      arrayValue(source['changes'], `${label} changes`, (member, memberLabel) => {
        const change = exactRecord(member, memberLabel, ['action', 'scope', 'path'], ['digest'])
        literalValue(change['action'], ['set', 'replace', 'remove'], `${memberLabel} action`)
        stringValue(change['scope'], `${memberLabel} scope`)
        stringValue(change['path'], `${memberLabel} path`)
        if (change['digest'] !== undefined) stringValue(change['digest'], `${memberLabel} digest`)
      })
      return
    case 'session-reference':
      sessionReferenceSourceValue(source, label, version)
      return
    case 'team-message':
      assertReleasedV0Keys(source, ['kind', 'teamId', 'messageId', 'senderId', 'senderName'], [], label)
      for (const key of ['teamId', 'messageId', 'senderId'] as const) nonEmptyString(source[key], `${label} ${key}`)
      stringValue(source['senderName'], `${label} senderName`)
      return
    case 'goal':
      assertReleasedV0Keys(source, ['kind', 'goalId', 'revision', 'round'], [], label)
      nonEmptyString(source['goalId'], `${label} goalId`)
      positiveIntegerValue(source['revision'], `${label} revision`)
      positiveIntegerValue(source['round'], `${label} round`)
      return
    case 'skill-invocation':
      assertReleasedV0Keys(source, ['kind', 'name', 'form'], [], label)
      nonEmptyString(source['name'], `${label} name`)
      literalValue(source['form'], ['instructions'], `${label} form`)
      return
    case 'skill-catalog':
      assertReleasedV0Keys(source, ['kind', 'form', 'entries'], ['update'], label)
      literalValue(source['form'], ['catalog'], `${label} form`)
      if (source['update'] !== undefined) literalValue(source['update'], [true], `${label} update`)
      arrayValue(source['entries'], `${label} entries`, (member, memberLabel) => {
        const entry = exactRecord(member, memberLabel, ['name', 'description'])
        nonEmptyString(entry['name'], `${memberLabel} name`)
        stringValue(entry['description'], `${memberLabel} description`)
      })
      return
    case 'coordinator':
    case 'subagent-report':
      assertReleasedV0Keys(source, ['kind', 'form', 'senderSessionId'], [], label)
      literalValue(source['form'], ['relay'], `${label} form`)
      nonEmptyString(source['senderSessionId'], `${label} senderSessionId`)
      return
    case 'subagent-settled':
      assertReleasedV0Keys(source, ['kind', 'form', 'summary', 'senderSessionId'], [], label)
      literalValue(source['form'], ['notice'], `${label} form`)
      stringValue(source['summary'], `${label} summary`)
      nonEmptyString(source['senderSessionId'], `${label} senderSessionId`)
      return
    case 'webhook':
      assertReleasedV0Keys(source, ['kind', 'provider', 'source', 'deliveryId', 'ruleId', 'form', 'summary'], [], label)
      for (const key of ['provider', 'source', 'deliveryId', 'ruleId'] as const) nonEmptyString(source[key], `${label} ${key}`)
      literalValue(source['form'], ['notice'], `${label} form`)
      stringValue(source['summary'], `${label} summary`)
      return
    default:
      nonEmptyString(source['kind'], `${label} kind`)
      return
  }
}

function pluginSourceValue(source: JsonRecord, label: string): void {
  const optional = ['form', 'sections', 'summary']
  if (source['plugin'] === 'compact') optional.push('compactionId', 'sourceCommandId')
  assertReleasedV0Keys(source, ['kind', 'plugin'], optional, label)
  nonEmptyString(source['plugin'], `${label} plugin`)
  if (source['plugin'] === 'compact') {
    nonEmptyString(source['compactionId'], `${label} compactionId`)
    if (source['sourceCommandId'] !== undefined) nonEmptyString(source['sourceCommandId'], `${label} sourceCommandId`)
  }
  const form = source['form']
  if (form === undefined) return
  literalValue(form, ['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'], `${label} form`)
  if (form === 'snapshot') {
    arrayValue(source['sections'], `${label} sections`, (member, memberLabel) => {
      const section = exactRecord(member, memberLabel, ['name', 'text'])
      nonEmptyString(section['name'], `${memberLabel} name`)
      stringValue(section['text'], `${memberLabel} text`)
    })
  } else if (source['sections'] !== undefined) {
    throw new SessionFormatError(`${label} sections require snapshot form`)
  }
  if (form === 'notice') stringValue(source['summary'], `${label} summary`)
  else if (source['summary'] !== undefined) throw new SessionFormatError(`${label} summary requires notice form`)
}

function sessionReferenceSourceValue(source: JsonRecord, label: string, version: number): void {
  assertReleasedV0Keys(source, ['kind', 'form', 'version', 'references'], [], label)
  literalValue(source['form'], ['recall'], `${label} form`)
  literalValue(source['version'], [1], `${label} version`)
  let expectedInputIndex = 0
  const sessionIds = new Set<string>()
  const references = arrayValue(source['references'], `${label} references`, (member, memberLabel) => {
    const reference = exactRecord(
      member,
      memberLabel,
      [
        'sessionId', 'label', 'capturedThroughSeq', 'compacted', 'originalMessages',
        'retainedMessages', 'omittedMessages', 'omittedBytes', 'truncated', 'inputIndex',
      ],
      version >= 1 ? ['capturedFormatVersion'] : [],
    )
    nonEmptyString(reference['sessionId'], `${memberLabel} sessionId`)
    stringValue(reference['label'], `${memberLabel} label`)
    if (reference['capturedThroughSeq'] !== null) countValue(reference['capturedThroughSeq'], `${memberLabel} capturedThroughSeq`)
    if (reference['capturedFormatVersion'] !== undefined) {
      const capturedVersion = countValue(
        reference['capturedFormatVersion'],
        `${memberLabel} capturedFormatVersion`,
      )
      if (capturedVersion < 1 || capturedVersion > version) {
        throw new SessionFormatError(`${memberLabel} capturedFormatVersion must be between 1 and ${version}`)
      }
    }
    booleanValue(reference['compacted'], `${memberLabel} compacted`)
    const original = countValue(reference['originalMessages'], `${memberLabel} originalMessages`)
    const retained = countValue(reference['retainedMessages'], `${memberLabel} retainedMessages`)
    const omitted = countValue(reference['omittedMessages'], `${memberLabel} omittedMessages`)
    const omittedBytes = countValue(reference['omittedBytes'], `${memberLabel} omittedBytes`)
    const inputIndex = countValue(reference['inputIndex'], `${memberLabel} inputIndex`)
    const truncated = reference['truncated']
    booleanValue(truncated, `${memberLabel} truncated`)
    if (retained > original || omitted !== original - retained) {
      throw new SessionFormatError(`${memberLabel} message counts are inconsistent`)
    }
    if (truncated !== (omitted > 0 || omittedBytes > 0)) {
      throw new SessionFormatError(`${memberLabel} truncated disagrees with omitted content`)
    }
    if (inputIndex !== expectedInputIndex) throw new SessionFormatError(`${label} inputIndex must match reference position`)
    expectedInputIndex += 1
    const sessionId = reference['sessionId']
    if (sessionIds.has(sessionId)) throw new SessionFormatError(`${label} repeats sessionId ${sessionId}`)
    sessionIds.add(sessionId)
  })
  if (references.length === 0) throw new SessionFormatError(`${label} references must be non-empty`)
}

function streamChunkValue(value: SessionFormatJsonValue | undefined, label: string): void {
  const chunk = releasedV0Record(value, label)
  switch (chunk['type']) {
    case 'block-start':
      assertReleasedV0Keys(chunk, ['type', 'index', 'blockType'], [], label)
      countValue(chunk['index'], `${label} index`)
      nonEmptyString(chunk['blockType'], `${label} blockType`)
      return
    case 'text-delta':
    case 'reasoning-delta':
      assertReleasedV0Keys(chunk, ['type', 'index', 'text'], [], label)
      countValue(chunk['index'], `${label} index`)
      stringValue(chunk['text'], `${label} text`)
      return
    case 'tool-call-delta':
      assertReleasedV0Keys(chunk, ['type', 'index', 'id', 'argumentsDelta'], ['name'], label)
      countValue(chunk['index'], `${label} index`)
      nonEmptyString(chunk['id'], `${label} id`)
      if (chunk['name'] !== undefined) stringValue(chunk['name'], `${label} name`)
      stringValue(chunk['argumentsDelta'], `${label} argumentsDelta`)
      return
    case 'block-end':
      assertReleasedV0Keys(chunk, ['type', 'index', 'block'], [], label)
      countValue(chunk['index'], `${label} index`)
      contentBlockValue(chunk['block'] as SessionFormatJsonValue, `${label} block`, 1)
      return
    case 'usage':
      assertReleasedV0Keys(chunk, ['type', 'usage'], [], label)
      tokenUsageValue(chunk['usage'], `${label} usage`)
      return
    case 'finish':
      assertReleasedV0Keys(chunk, ['type', 'reason'], ['replayState'], label)
      finishReasonValue(chunk['reason'], `${label} reason`)
      if (chunk['replayState'] !== undefined) replayEnvelopeValue(chunk['replayState'], `${label} replayState`)
      return
    default:
      throw new SessionFormatError(`${label} has unknown stream chunk type ${JSON.stringify(chunk['type'])}`)
  }
}

function finishReasonValue(value: SessionFormatJsonValue | undefined, label: string): void {
  const reason = releasedV0Record(value, label)
  if (reason['kind'] === 'aborted' || reason['kind'] === 'error') {
    assertReleasedV0Keys(reason, ['kind', 'failure'], [], label)
    llmFailureValue(reason['failure'], `${label} failure`)
    return
  }
  if (reason['kind'] === 'stop' || reason['kind'] === 'tool-calls' || reason['kind'] === 'max-tokens') {
    assertReleasedV0Keys(reason, ['kind'], [], label)
  }
  nonEmptyString(reason['kind'], `${label} kind`)
}

function replayEnvelopeValue(value: SessionFormatJsonValue | undefined, label: string): void {
  const replay = exactRecord(value, label, ['response'], ['blocks'])
  if (replay['blocks'] !== undefined && !Array.isArray(replay['blocks'])) {
    throw new SessionFormatError(`${label} blocks must be an array`)
  }
}

function turnEndReasonValue(value: SessionFormatJsonValue | undefined, label: string): void {
  const reason = releasedV0Record(value, label)
  switch (reason['kind']) {
    case 'completed':
    case 'blocked':
    case 'max-tokens':
    case 'interrupted':
      assertReleasedV0Keys(reason, ['kind'], [], label)
      return
    case 'aborted': {
      assertReleasedV0Keys(reason, ['kind', 'reason'], [], label)
      const cause = releasedV0Record(reason['reason'], `${label} abort cause`)
      if (cause['kind'] === 'hook') {
        assertReleasedV0Keys(cause, ['kind', 'reason'], [], `${label} abort cause`)
        stringValue(cause['reason'], `${label} abort reason`)
      } else {
        assertReleasedV0Keys(cause, ['kind'], [], `${label} abort cause`)
        literalValue(cause['kind'], ['user', 'parent', 'disposed', 'legacy'], `${label} abort kind`)
      }
      return
    }
    case 'error':
      assertReleasedV0Keys(reason, ['kind', 'error'], [], label)
      llmFailureValue(reason['error'], `${label} error`)
      return
    default:
      nonEmptyString(reason['kind'], `${label} kind`)
      return
  }
}

function requestHeaderValue(value: SessionFormatJsonValue | undefined, label: string): void {
  const header = exactRecord(value, label, ['config'], ['adapterDefaults', 'system', 'tools'])
  const config = exactRecord(
    header['config'],
    `${label} config`,
    ['provider', 'model'],
    ['reasoningEffort', 'temperature', 'maxTokens', 'stop'],
  )
  nonEmptyString(config['provider'], `${label} provider`)
  nonEmptyString(config['model'], `${label} model`)
  if (config['reasoningEffort'] !== undefined) nonEmptyString(config['reasoningEffort'], `${label} reasoningEffort`)
  if (config['temperature'] !== undefined) finiteNumberValue(config['temperature'], `${label} temperature`)
  if (config['maxTokens'] !== undefined) positiveIntegerValue(config['maxTokens'], `${label} maxTokens`)
  if (config['stop'] !== undefined) arrayValue(config['stop'], `${label} stop`, stringValue)
  if (header['adapterDefaults'] !== undefined) {
    const defaults = exactRecord(header['adapterDefaults'], `${label} adapterDefaults`, [], ['reasoningEffort', 'maxTokens'])
    for (const [key, marker] of Object.entries(defaults)) {
      literalValue(marker, [true], `${label} adapterDefaults ${key}`)
      if (!Object.hasOwn(config, key)) throw new SessionFormatError(`${label} adapter default ${key} lacks config value`)
    }
  }
  if (header['system'] !== undefined) stringValue(header['system'], `${label} system`)
  if (header['tools'] !== undefined) arrayValue(header['tools'], `${label} tools`, toolSchemaValue)
}

function toolSchemaValue(value: SessionFormatJsonValue, label: string): void {
  const schema = exactRecord(value, label, ['name', 'description', 'parameters'])
  nonEmptyString(schema['name'], `${label} name`)
  stringValue(schema['description'], `${label} description`)
  releasedV0Record(schema['parameters'], `${label} parameters`)
}

function shadowedValue(data: JsonRecord, eventSeq: number, label: string): void {
  const range = exactRecord(data['shadowedRange'], `${label} shadowedRange`, ['start', 'end'])
  const start = earlierSeq(range['start'], eventSeq, `${label} shadowedRange start`)
  const end = earlierSeq(range['end'], eventSeq, `${label} shadowedRange end`)
  const seqs = seqArray(data['shadowedSeqs'], eventSeq, `${label} shadowedSeqs`, true)
  if (seqs[0] !== start || seqs.at(-1) !== end) {
    throw new SessionFormatError(`${label} shadowedRange must match shadowedSeqs endpoints`)
  }
  countValue(data['shadowedTokenCount'], `${label} shadowedTokenCount`)
}

function goalChangeValue(data: JsonRecord, label: string): void {
  literalValue(data['kind'], ['goal/change'], `${label} kind`)
  literalValue(data['version'], [1], `${label} version`)
  if (data['operation'] === 'clear') {
    assertReleasedV0Keys(data, ['kind', 'version', 'operation', 'cleared', 'clearedAt'], [], `${label} data`)
    goalRefValue(data['cleared'], `${label} cleared`)
    countValue(data['clearedAt'], `${label} clearedAt`)
    return
  }
  assertReleasedV0Keys(
    data,
    ['kind', 'version', 'operation', 'goal', 'roundsStarted', 'createdAt', 'updatedAt'],
    [],
    `${label} data`,
  )
  literalValue(data['operation'], ['create', 'edit', 'pause', 'resume', 'complete', 'block'], `${label} operation`)
  goalSnapshotValue(data['goal'], `${label} goal`)
  countValue(data['roundsStarted'], `${label} roundsStarted`)
  countValue(data['createdAt'], `${label} createdAt`)
  countValue(data['updatedAt'], `${label} updatedAt`)
}

function goalRefValue(value: SessionFormatJsonValue | undefined, label: string): void {
  const ref = exactRecord(value, label, ['id', 'revision'])
  nonEmptyString(ref['id'], `${label} id`)
  positiveIntegerValue(ref['revision'], `${label} revision`)
}

function goalSnapshotValue(value: SessionFormatJsonValue | undefined, label: string): void {
  const goal = exactRecord(value, label, ['id', 'revision', 'objective', 'phase', 'maxGoalRounds'], ['blockedReason'])
  nonEmptyString(goal['id'], `${label} id`)
  positiveIntegerValue(goal['revision'], `${label} revision`)
  nonEmptyString(goal['objective'], `${label} objective`)
  literalValue(goal['phase'], ['active', 'paused', 'blocked', 'complete'], `${label} phase`)
  positiveIntegerValue(goal['maxGoalRounds'], `${label} maxGoalRounds`)
  if (goal['phase'] === 'blocked') {
    const reason = exactRecord(goal['blockedReason'], `${label} blockedReason`, ['code', 'message'])
    nonEmptyString(reason['code'], `${label} blocked code`)
    nonEmptyString(reason['message'], `${label} blocked message`)
  } else if (goal['blockedReason'] !== undefined) {
    throw new SessionFormatError(`${label} blockedReason requires blocked phase`)
  }
}

function scheduleChangeValue(data: JsonRecord, label: string): void {
  literalValue(data['version'], [1], `${label} version`)
  if (data['operation'] === 'create') {
    assertReleasedV0Keys(data, ['version', 'operation', 'schedule'], [], `${label} data`)
    scheduleRecordValue(data['schedule'], `${label} schedule`)
    return
  }
  assertReleasedV0Keys(
    data,
    ['version', 'operation', 'id'],
    data['operation'] === 'dispatch' ? ['acceptedAt'] : [],
    `${label} data`,
  )
  literalValue(data['operation'], ['delete', 'dispatch'], `${label} operation`)
  scheduleIdValue(data['id'], `${label} id`)
  if (data['acceptedAt'] !== undefined) instantValue(data['acceptedAt'], `${label} acceptedAt`)
}

function scheduleRecordValue(value: SessionFormatJsonValue | undefined, label: string): void {
  const record = releasedV0Record(value, label)
  if (record['kind'] === 'after') {
    assertReleasedV0Keys(record, ['id', 'kind', 'prompt', 'afterSeconds', 'scheduledAt'], [], label)
    positiveIntegerValue(record['afterSeconds'], `${label} afterSeconds`)
  } else if (record['kind'] === 'at') {
    assertReleasedV0Keys(record, ['id', 'kind', 'prompt', 'scheduledAt'], [], label)
  } else if (record['kind'] === 'every') {
    assertReleasedV0Keys(record, ['id', 'kind', 'prompt', 'everySeconds', 'scheduledAt'], [], label)
    const seconds = positiveIntegerValue(record['everySeconds'], `${label} everySeconds`)
    if (seconds < 300) throw new SessionFormatError(`${label} everySeconds must be at least 300`)
  } else {
    throw new SessionFormatError(`${label} has unknown schedule kind`)
  }
  scheduleIdValue(record['id'], `${label} id`)
  nonEmptyString(record['prompt'], `${label} prompt`)
  instantValue(record['scheduledAt'], `${label} scheduledAt`)
}

function scheduleIdValue(value: SessionFormatJsonValue | undefined, label: string): void {
  nonEmptyString(value, label)
  if (value.trim() !== value) throw new SessionFormatError(`${label} must not have surrounding whitespace`)
}

function instantValue(value: SessionFormatJsonValue | undefined, label: string): void {
  if (typeof value !== 'string'
    || !/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value) {
    throw new SessionFormatError(`${label} must be a canonical UTC instant`)
  }
}

function titleSourceValue(value: SessionFormatJsonValue | undefined, label: string): void {
  const source = releasedV0Record(value, label)
  if (source['kind'] === 'provider') {
    assertReleasedV0Keys(source, ['kind', 'provider'], ['model'], label)
    nonEmptyString(source['provider'], `${label} provider`)
    if (source['model'] !== undefined) modelRouteValue(source['model'], `${label} model`)
    return
  }
  assertReleasedV0Keys(source, ['kind'], [], label)
  literalValue(source['kind'], ['fallback', 'user'], `${label} kind`)
}

function modelRouteValue(value: SessionFormatJsonValue | undefined, label: string): void {
  const route = exactRecord(value, label, ['provider', 'model'])
  nonEmptyString(route['provider'], `${label} provider`)
  nonEmptyString(route['model'], `${label} model`)
}

function subagentDescriptorValue(data: JsonRecord, label: string): void {
  literalValue(data['version'], [3], `${label} version`)
  nonEmptyString(data['provider'], `${label} provider`)
  if (data['mode'] === 'one-shot') {
    assertReleasedV0Keys(data, ['mode', 'version', 'provider'], ['label'], `${label} data`)
    if (data['label'] !== undefined) stringValue(data['label'], `${label} label`)
    return
  }
  literalValue(data['mode'], ['continuable'], `${label} mode`)
  nonEmptyString(data['label'], `${label} label`)
  for (const key of ['agentProvider', 'agentModel', 'agentReasoningEffort', 'persona'] as const) {
    if (data[key] !== undefined) nonEmptyString(data[key], `${label} ${key}`)
  }
  if ((data['agentProvider'] === undefined) !== (data['agentModel'] === undefined)) {
    throw new SessionFormatError(`${label} agentProvider and agentModel must be paired`)
  }
  if (data['toolFilter'] !== undefined) {
    const filter = exactRecord(data['toolFilter'], `${label} toolFilter`, [], ['allow', 'deny'])
    if (filter['allow'] === undefined && filter['deny'] === undefined) {
      throw new SessionFormatError(`${label} toolFilter requires allow or deny`)
    }
    if (filter['allow'] !== undefined) arrayValue(filter['allow'], `${label} allow`, nonEmptyString)
    if (filter['deny'] !== undefined) arrayValue(filter['deny'], `${label} deny`, nonEmptyString)
  }
}

function allowedModelsValue(value: SessionFormatJsonValue | undefined, label: string): void {
  const seen = new Set<string>()
  const routes = arrayValue(value, label, (member, memberLabel) => {
    const route = exactRecord(member, memberLabel, ['provider', 'model'])
    nonEmptyString(route['provider'], `${memberLabel} provider`)
    nonEmptyString(route['model'], `${memberLabel} model`)
    const key = `${route['provider']}\0${route['model']}`
    if (seen.has(key)) throw new SessionFormatError(`${label} repeats route ${key}`)
    seen.add(key)
  })
  if (routes.length === 0) throw new SessionFormatError(`${label} must be non-empty`)
}

function teamSelector(data: JsonRecord, label: string): void {
  literalValue(data['version'], [1], `${label} version`)
  nonEmptyString(data['teamId'], `${label} teamId`)
}

function teamMemberValue(value: SessionFormatJsonValue | undefined, label: string): void {
  const member = exactRecord(value, label, ['id', 'name', 'description', 'provider', 'context', 'phase'], ['error'])
  nonEmptyString(member['id'], `${label} id`)
  stringValue(member['name'], `${label} name`)
  stringValue(member['description'], `${label} description`)
  stringValue(member['provider'], `${label} provider`)
  literalValue(member['context'], ['fresh', 'fork'], `${label} context`)
  literalValue(member['phase'], ['provisioning', 'active', 'failed'], `${label} phase`)
  if (member['error'] !== undefined) stringValue(member['error'], `${label} error`)
}

function teamTaskValue(value: SessionFormatJsonValue | undefined, label: string): void {
  const task = exactRecord(
    value,
    label,
    ['id', 'revision', 'subject', 'description', 'status', 'blockedBy', 'writeScopes'],
    ['ownerId'],
  )
  nonEmptyString(task['id'], `${label} id`)
  positiveIntegerValue(task['revision'], `${label} revision`)
  stringValue(task['subject'], `${label} subject`)
  stringValue(task['description'], `${label} description`)
  literalValue(task['status'], ['pending', 'in_progress', 'completed', 'deleted'], `${label} status`)
  if (task['ownerId'] !== undefined) nonEmptyString(task['ownerId'], `${label} ownerId`)
  arrayValue(task['blockedBy'], `${label} blockedBy`, nonEmptyString)
  arrayValue(task['writeScopes'], `${label} writeScopes`, stringValue)
}

function teamMessageValue(value: SessionFormatJsonValue | undefined, label: string, version: number): void {
  const message = exactRecord(value, label, ['id', 'senderId', 'senderName', 'targetId', 'delivery', 'content'])
  for (const key of ['id', 'senderId', 'targetId'] as const) nonEmptyString(message[key], `${label} ${key}`)
  stringValue(message['senderName'], `${label} senderName`)
  literalValue(message['delivery'], ['quiet', 'wakeup'], `${label} delivery`)
  contentBlocksValue(message['content'], `${label} content`, version)
}

function workflowIdentity(data: JsonRecord, label: string): void {
  nonEmptyString(data['runId'], `${label} runId`)
  positiveIntegerValue(data['seq'], `${label} seq`)
}

function deepSeekSearchBodyValue(value: SessionFormatJsonValue | undefined, label: string): void {
  const body = exactRecord(value, label, ['model', 'max_tokens', 'messages', 'tools'])
  nonEmptyString(body['model'], `${label} model`)
  positiveIntegerValue(body['max_tokens'], `${label} max_tokens`)
  const messages = arrayValue(body['messages'], `${label} messages`, (member, memberLabel) => {
    const message = exactRecord(member, memberLabel, ['role', 'content'])
    literalValue(message['role'], ['user'], `${memberLabel} role`)
    const content = arrayValue(message['content'], `${memberLabel} content`, (block, blockLabel) => {
      const text = exactRecord(block, blockLabel, ['type', 'text'])
      literalValue(text['type'], ['text'], `${blockLabel} type`)
      stringValue(text['text'], `${blockLabel} text`)
    })
    if (content.length !== 1) throw new SessionFormatError(`${memberLabel} content must contain one text block`)
  })
  if (messages.length !== 1) throw new SessionFormatError(`${label} messages must contain one user message`)
  const tools = arrayValue(body['tools'], `${label} tools`, (member, memberLabel) => {
    const tool = exactRecord(member, memberLabel, ['type', 'name', 'max_uses'])
    literalValue(tool['type'], ['web_search_20250305'], `${memberLabel} type`)
    literalValue(tool['name'], ['web_search'], `${memberLabel} name`)
    positiveIntegerValue(tool['max_uses'], `${memberLabel} max_uses`)
  })
  if (tools.length !== 1) throw new SessionFormatError(`${label} tools must contain one web search tool`)
}
