import { describe, expect, it } from 'vitest'
import type { SessionFormatEvent, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import {
  RELEASED_V0_EVENT_TYPES,
  RELEASED_V0_EVENT_DISPOSITIONS,
} from '../src/index.ts'
import { assertReleasedEventPayload, assertReleasedSurfaceMetadata } from '../src/validation.ts'
import { restoreV0ToV1, restoreV1 } from '../src/testing/restore.ts'
import {
  assertNormalizedReleasedV0Artifact,
  assertReleasedV0SourceArtifact,
  assertReleasedV1Artifact,
  assertReleasedV1MigrationSource,
  assertReleasedV1PhysicalArtifact,
} from '../src/testing/validation.ts'

const v0Header = {
  type: 'session', version: 0, id: 'validation', createdAt: 1, delegationDepth: 0,
} as const
const v1Header = { ...v0Header, version: 1 } as const
const textBlock = { type: 'text', text: 'text' } as const
const userMessage = {
  id: 'user-1', role: 'user', content: [textBlock], source: { kind: 'user' },
} as const
const assistantMessage = {
  id: 'assistant-1', role: 'assistant', content: [textBlock],
  source: { kind: 'model', provider: 'mock', model: 'mock' },
} as const
const toolMessage = {
  id: 'tool-1', role: 'user',
  content: [{ type: 'tool-result', toolCallId: 'call-1', content: [textBlock], isError: false }],
  source: { kind: 'tool', callId: 'call-1' },
} as const

const validPayloads: Readonly<Record<string, SessionFormatJsonValue>> = {
  'agent-preset/selected': { agentPreset: 'default' },
  'agent/inbox/spliced': { target: 'next-turn', start: 0, inserted: [userMessage] },
  'approval/asked': { id: 'approval-1', toolName: 'bash', callId: 'call-1', reason: 'needed' },
  'approval/decided': { id: 'approval-1', outcome: 'allowed-once' },
  'approval/policy': { policy: 'ask', source: 'delegation' },
  'assistant/chunk': { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'x' } },
  'assistant/message': { turn: 1, step: 0, message: assistantMessage, usage: { inputTokens: 1, outputTokens: 1 } },
  'command/done': { commandId: 'command-1', kind: 'success', sourceEventSeq: 0 },
  'command/run': { commandId: 'command-1', name: 'compact', args: ' now', source: { kind: 'user' } },
  'compaction/end': { compactionId: 'compact-1', turn: null },
  'compaction/prune': { shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [0, 1], shadowedTokenCount: 2 },
  'compaction/start': { compactionId: 'compact-1', turn: 1 },
  'compaction/summary': {
    compactionId: 'compact-1', summary: [textBlock],
    shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [0, 1], shadowedTokenCount: 2,
    provider: 'mock', model: 'mock', rawOutput: [textBlock], llmStreamCall: true,
  },
  'feedback/record': { text: 'feedback' },
  'goal/change': {
    kind: 'goal/change', version: 1, operation: 'create',
    goal: { id: 'goal-1', revision: 1, objective: 'ship', phase: 'active', maxGoalRounds: 3 },
    roundsStarted: 0, createdAt: 1, updatedAt: 1,
  },
  'hook/invoked': { turn: 1, point: 'PreToolUse', dialect: 'claude-code', handlerId: 'hook-1' },
  'hook/result': { turn: 1, point: 'PreToolUse', handlerId: 'hook-1', decision: 'pass', durationMs: 1 },
  'llm/retry': {
    retryId: 'retry-1', turn: 1, step: 0, provider: 'mock', mode: 'normal', policyKey: 'default',
    retry: 1, maxRetries: 2, delayMs: 10, failure: { message: 'retry', code: 'SERVER' },
  },
  'llm/retry-started': { retryId: 'retry-1', turn: 1, step: 0, retry: 1 },
  'model/selection': { provider: 'mock', model: 'mock', reasoningEffort: 'high' },
  'permission/preset': { preset: 'default' },
  'plan/mode': { active: true },
  'request/context': { provider: 'mock', model: 'mock', contextWindow: 8192 },
  'request/header': {
    header: {
      config: { provider: 'mock', model: 'mock', reasoningEffort: 'high', maxTokens: 100 },
      adapterDefaults: { reasoningEffort: true, maxTokens: true },
      system: 'system',
      tools: [{ name: 'tool', description: 'Tool', parameters: { type: 'object' } }],
    },
    reason: 'initial',
  },
  'sandbox/mode': { mode: 'workspace-write', source: 'delegation' },
  'schedule/change': {
    version: 1, operation: 'create',
    schedule: { id: 'schedule-1', kind: 'after', prompt: 'remember', afterSeconds: 60, scheduledAt: '2026-08-31T00:00:00.000Z' },
  },
  'session-log-deepseek/delivery-accepted': { sessionId: 'validation', throughSeq: 0, sessionFormatVersion: 1 },
  'session/end-seed': {},
  'session/title': { title: 'Title', messageSeqs: [0], source: { kind: 'fallback' } },
  'session/title-llm-request': {
    titleProvider: 'title-1', messageSeqs: [0], route: { provider: 'mock', model: 'mock' },
    system: 'title', messages: [userMessage], maxTokens: 20,
  },
  'step/end': { turn: 1, step: 0 },
  'step/start': { turn: 1, step: 0 },
  'subagent/descriptor': {
    mode: 'continuable', version: 3, provider: 'in-process', label: 'child',
    agentProvider: 'mock', agentModel: 'mock', toolFilter: { allow: ['read'] },
  },
  'subagent/model-selection-policy': { allowedModels: [{ provider: 'mock', model: 'mock' }] },
  'team/member': {
    version: 1, teamId: 'team-1',
    member: { id: 'member-1', name: 'worker', description: 'work', provider: 'in-process', context: 'fresh', phase: 'active' },
  },
  'team/message/delivered': { version: 1, teamId: 'team-1', messageId: 'message-1', targetId: 'member-1' },
  'team/message/queued': {
    version: 1, teamId: 'team-1',
    message: {
      id: 'message-1', senderId: 'lead', senderName: 'lead', targetId: 'member-1',
      delivery: 'quiet', content: [textBlock],
    },
  },
  'team/task': {
    version: 1, teamId: 'team-1',
    task: {
      id: 'task-1', revision: 1, subject: 'subject', description: 'description', status: 'pending',
      blockedBy: [], writeScopes: ['/work'],
    },
  },
  'todo/write': { todos: [{ content: 'work', status: 'in_progress' }] },
  'tool-workflow/agent-end': { runId: 'run-1', seq: 1, outcome: 'completed' },
  'tool-workflow/agent-start': { runId: 'run-1', seq: 1, label: 'worker', phase: 'build', childId: 'child-1' },
  'tool-workflow/run-end': { runId: 'run-1', stopReason: 'completed' },
  'tool-workflow/run-start': { runId: 'run-1', name: 'workflow' },
  'tool/call': { turn: 1, step: 0, callId: 'call-1', name: 'read', arguments: '{}' },
  'tool/code-dispatch': {
    rootCallId: 'root', parentCallId: 'parent', subCallId: 'sub', name: 'read', arguments: { path: '/work' },
    isError: false, content: [textBlock],
  },
  'tool/code-dispatch-start': {
    rootCallId: 'root', parentCallId: 'parent', subCallId: 'sub', name: 'read', arguments: { path: '/work' },
  },
  'tool/result': { turn: 1, step: 0, message: toolMessage, error: { name: 'Error', code: 'FAILED' }, meta: { seq: 999 } },
  'turn/end': { turn: 1, reason: { kind: 'completed' } },
  'turn/start': { turn: 1 },
  'user/message': userMessage,
  'web/deepseek-search-llm-request': {
    endpoint: 'https://example.test/messages', apiVersion: '2023-06-01',
    body: {
      model: 'deepseek-chat', max_tokens: 100,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'search' }] }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
    },
  },
}

function v1Artifact(type: string, data: SessionFormatJsonValue) {
  const surface = type === 'user/message' || type === 'assistant/message' || type === 'tool/result'
  const event = {
    type,
    seq: 3,
    time: 4,
    data,
    ...(surface ? { surfaceOp: 'append' } : {}),
  }
  return {
    header: {
      version: 1, id: 'validation', createdAt: 1, isSeeded: false, delegationDepth: 0,
    },
    inheritedEventCount: 0,
    events: [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 0 } },
      { type: 'step/end', seq: 2, time: 3, data: { turn: 1, step: 0 } },
      event,
    ],
  }
}

function assertPayload(type: string, data: SessionFormatJsonValue): void {
  assertReleasedEventPayload({ type, seq: 3, time: 4, data }, 1)
}

function invalidLeafMutations(
  type: string,
  value: SessionFormatJsonValue,
  path: readonly string[] = [],
): Array<{ readonly path: string; readonly value: SessionFormatJsonValue }> {
  const joined = path.join('.')
  const opaque = RELEASED_V0_EVENT_DISPOSITIONS[type]?.opaque.includes(path[0] as string) === true
    || path.at(-1) === 'replayState'
    || path.at(-1) === 'parameters'
  if (opaque) return []
  const replacement: SessionFormatJsonValue = value === null
    ? false
    : typeof value === 'string' ? 1
      : typeof value === 'number' ? 'invalid'
        : typeof value === 'boolean' ? 'invalid'
          : Array.isArray(value) ? {}
            : []
  const mutations: Array<{ readonly path: string; readonly value: SessionFormatJsonValue }> = path.length === 0
    ? []
    : [{ path: joined, value: replacement }]
  if (Array.isArray(value)) {
    const members = value as readonly SessionFormatJsonValue[]
    members.forEach((member, index) => {
      mutations.push(...invalidLeafMutations(type, member, [...path, String(index)]))
    })
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, member] of Object.entries(value)) {
      mutations.push(...invalidLeafMutations(type, member, [...path, key]))
    }
  }
  return mutations
}

function replaceAtPath(value: SessionFormatJsonValue, path: string, replacement: SessionFormatJsonValue): SessionFormatJsonValue {
  const copy = structuredClone(value)
  const keys = path.split('.')
  let current = copy as unknown as Record<string, SessionFormatJsonValue>
  for (const key of keys.slice(0, -1)) current = current[key] as unknown as Record<string, SessionFormatJsonValue>
  current[keys.at(-1) as string] = replacement
  return copy
}

describe('released event and payload inventory', () => {
  it('has an executable valid fixture for every frozen released-v0 event type', () => {
    expect(Object.keys(validPayloads).sort()).toEqual([...RELEASED_V0_EVENT_TYPES].sort())
    expect(RELEASED_V0_EVENT_TYPES).toHaveLength(51)
    expect(RELEASED_V0_EVENT_TYPES
      .filter(type => type !== 'assistant/chunk')
      .every(type => KNOWN_SESSION_EVENT_TYPES.has(type))).toBe(true)
    expect(KNOWN_SESSION_EVENT_TYPES.has('assistant/chunk')).toBe(false)
    for (const [type, data] of Object.entries(validPayloads)) {
      expect(() => { assertPayload(type, data) }, type).not.toThrow()
    }
  })

  it('refuses an unexpected member on every known payload', () => {
    for (const [type, data] of Object.entries(validPayloads)) {
      const changed = { ...(data as Record<string, SessionFormatJsonValue>), unexpected: true }
      expect(() => { assertPayload(type, changed) }, type).toThrow(/unexpected member/)
    }
  })

  it('refuses nested schema drift across core and owner payload families', () => {
    const cases: Array<[string, SessionFormatJsonValue]> = [
      ['assistant/message', {
        ...(validPayloads['assistant/message'] as Record<string, SessionFormatJsonValue>),
        message: { ...assistantMessage, content: [{ ...textBlock, extra: true }] },
      }],
      ['llm/retry', {
        ...(validPayloads['llm/retry'] as Record<string, SessionFormatJsonValue>),
        failure: { message: 'bad', code: 'BAD', extra: true },
      }],
      ['request/header', {
        ...(validPayloads['request/header'] as Record<string, SessionFormatJsonValue>),
        header: { config: { provider: 'mock', model: 'mock', extra: true } },
      }],
      ['schedule/change', {
        version: 1, operation: 'create',
        schedule: { id: 'x', kind: 'at', prompt: 'x', scheduledAt: '2026-08-31T00:00:00.000Z', extra: true },
      }],
      ['goal/change', {
        ...(validPayloads['goal/change'] as Record<string, SessionFormatJsonValue>),
        goal: { id: 'g', revision: 1, objective: 'x', phase: 'active', maxGoalRounds: 1, extra: true },
      }],
      ['team/task', {
        ...(validPayloads['team/task'] as Record<string, SessionFormatJsonValue>),
        task: {
          id: 'task-1', revision: 1, subject: 'x', description: 'x', status: 'pending',
          blockedBy: [], writeScopes: [], extra: true,
        },
      }],
      ['todo/write', { todos: [{ content: 'x', status: 'pending', extra: true }] }],
      ['web/deepseek-search-llm-request', {
        ...(validPayloads['web/deepseek-search-llm-request'] as Record<string, SessionFormatJsonValue>),
        body: { model: 'x', max_tokens: 1, messages: [], tools: [], extra: true },
      }],
    ]
    for (const [index, [type, data]] of cases.entries()) {
      expect(() => { assertPayload(type, data) }, `${type}-${index}`).toThrow()
    }
  })

  it('refuses type corruption at every non-opaque nested member in the frozen fixture inventory', () => {
    let mutations = 0
    for (const [type, data] of Object.entries(validPayloads)) {
      for (const mutation of invalidLeafMutations(type, data)) {
        const changed = replaceAtPath(data, mutation.path, mutation.value)
        expect(
          () => { assertPayload(type, changed) },
          `${type}.${mutation.path}`,
        ).toThrow()
        mutations += 1
      }
    }
    expect(mutations).toBeGreaterThan(250)
  })

  it('allows explicit opaque tool metadata and PTC arguments losslessly', () => {
    for (const type of ['tool/result', 'tool/code-dispatch', 'tool/code-dispatch-start']) {
      const data = structuredClone(validPayloads[type] as SessionFormatJsonValue)
      expect(() => { assertPayload(type, data) }).not.toThrow()
      expect(data).toEqual(validPayloads[type])
    }
  })

  it('refuses opaque members that are not lossless JSON without snapshotting them', () => {
    const data = {
      ...(validPayloads['tool/result'] as Record<string, unknown>),
      meta: { value: undefined },
    }
    expect(() => { assertPayload('tool/result', data as unknown as SessionFormatJsonValue) })
      .toThrow(/opaque meta is not lossless JSON/)
  })

  it.each([
    ['user/message content block', 'user/message', {
      ...userMessage,
      content: [{ type: 'future-block', private: { preserved: true } }],
    }],
    ['user/message source', 'user/message', {
      ...userMessage,
      source: { kind: 'future-source', private: { preserved: true } },
    }],
    ['assistant finish reason', 'assistant/chunk', {
      turn: 1, step: 0,
      chunk: { type: 'finish', reason: { kind: 'future-reason', private: { preserved: true } } },
    }],
    ['turn/end reason', 'turn/end', {
      turn: 1, reason: { kind: 'future-reason', private: { preserved: true } },
    }],
  ] as const)('preserves an unknown merge-extensible %s arm', (_name, type, data) => {
    expect(() => { assertPayload(type, data) }).not.toThrow()
  })

  it('refuses unknown v0 events even when the envelope marks them ignorable', () => {
    const row = { type: 'plugin/unknown', seq: 0, time: 1, data: {}, ignorable: true }
    expect(() => restoreV0ToV1(v0Header, [row]))
      .toThrow(/unknown historical event.*refuses.*ignorable/)
  })

  it('exercises each released test validation policy', () => {
    const v0 = {
      header: { version: 0, id: 'validation', createdAt: 1, isSeeded: false, delegationDepth: 0 },
      inheritedEventCount: 0,
      events: [],
    } as const
    const v1 = { ...v0, header: { ...v0.header, version: 1 } } as const
    const forwardCompatible = {
      ...v1,
      events: [{ type: 'plugin/future', seq: 0, time: 1, data: {}, ignorable: true }],
    } as const

    expect(() => { assertReleasedV0SourceArtifact(v0) }).not.toThrow()
    expect(() => { assertNormalizedReleasedV0Artifact({
      ...v0,
      events: [{ type: 'feedback/record', seq: 0, time: 1, data: { text: 'retained' } }],
    }) }).not.toThrow()
    expect(() => { assertReleasedV1MigrationSource(v1) }).not.toThrow()
    expect(() => { assertReleasedV1MigrationSource(forwardCompatible) }).not.toThrow()
    expect(() => { assertReleasedV1PhysicalArtifact(v1) }).not.toThrow()
    expect(() => { assertReleasedV0SourceArtifact({
      ...v0,
      events: [{
        type: 'steering/message', seq: 0, time: 1, surfaceOp: 'append',
        data: { turn: 1, content: [], source: { kind: 'user' } },
      }],
    }) }).not.toThrow()
    expect(() => { assertReleasedV0SourceArtifact({
      ...v0,
      events: [{ type: 'compact/start', seq: 0, time: 1, data: { turn: null } }],
    }) }).not.toThrow()
    expect(() => { assertReleasedV0SourceArtifact({
      ...v0,
      events: [{ type: 'plugin/unknown', seq: 0, time: 1, data: {}, ignorable: true }],
    }) }).toThrow(/unknown historical event/)
  })

  it('permits empty Assistant provenance only under the released-v1 policy', () => {
    const assistant = {
      type: 'assistant/message', seq: 1, time: 2, data: {},
      sourceEventSeqs: [], surfaceOp: 'append',
    }
    expect(() => { assertReleasedSurfaceMetadata(assistant, 1, assistant.type, 'allow-empty-assistant') })
      .not.toThrow()
    expect(() => { assertReleasedSurfaceMetadata(assistant, 1, assistant.type, 'forbid-assistant') })
      .toThrow(/obsolete chunk provenance/)
  })

  it('keeps capturedFormatVersion v1-only inside session-reference sources', () => {
    const data = {
      id: 'reference', role: 'user', content: [textBlock],
      source: {
        kind: 'session-reference', form: 'recall', version: 1,
        references: [{
          sessionId: 'source', label: 'Source', capturedFormatVersion: 1, capturedThroughSeq: 0,
          compacted: false, originalMessages: 1, retainedMessages: 1, omittedMessages: 0,
          omittedBytes: 0, truncated: false, inputIndex: 0,
        }],
      },
    }
    const event = { type: 'user/message', seq: 0, time: 1, data, surfaceOp: 'append' }
    expect(() => restoreV0ToV1(v0Header, [event]))
      .toThrow(/capturedFormatVersion/)
    expect(restoreV1(v1Header, [event]).events).toEqual([event])
  })

  it('accepts every released nested union variant and optional member', () => {
    const sources: SessionFormatJsonValue[] = [
      { kind: 'user', rpcId: 'rpc-1', clientTimeZone: 'Asia/Shanghai' },
      { kind: 'plugin', plugin: 'plain' },
      { kind: 'plugin', plugin: 'instructions', form: 'instructions' },
      { kind: 'plugin', plugin: 'catalog', form: 'catalog' },
      { kind: 'plugin', plugin: 'snapshot', form: 'snapshot', sections: [{ name: 'one', text: 'value' }] },
      { kind: 'plugin', plugin: 'notice', form: 'notice', summary: 'notice' },
      { kind: 'plugin', plugin: 'relay', form: 'relay' },
      { kind: 'plugin', plugin: 'recall', form: 'recall' },
      { kind: 'plugin', plugin: 'compact', compactionId: 'compact-1', sourceCommandId: 'command-1' },
      { kind: 'model', provider: 'mock', model: 'mock', replayState: { private: true } },
      { kind: 'tool', callId: 'call-1' },
      {
        kind: 'agent-instructions', form: 'instructions', baseline: true, baselineIdentity: 'base',
        changes: [
          { action: 'set', scope: '.', path: 'AGENTS.md', digest: 'one' },
          { action: 'replace', scope: 'src', path: 'src/AGENTS.md' },
          { action: 'remove', scope: 'old', path: 'old/AGENTS.md' },
        ],
      },
      { kind: 'agent-instructions', form: 'instructions', changes: [] },
      {
        kind: 'session-reference', form: 'recall', version: 1,
        references: [{
          sessionId: 'source', label: 'Source', capturedFormatVersion: 1, capturedThroughSeq: null,
          compacted: true, originalMessages: 2, retainedMessages: 1, omittedMessages: 1,
          omittedBytes: 20, truncated: true, inputIndex: 0,
        }],
      },
      {
        kind: 'session-reference', form: 'recall', version: 1,
        references: [{
          sessionId: 'source-without-version', label: 'Source', capturedThroughSeq: 0,
          compacted: false, originalMessages: 1, retainedMessages: 1, omittedMessages: 0,
          omittedBytes: 0, truncated: false, inputIndex: 0,
        }],
      },
      { kind: 'team-message', teamId: 'team', messageId: 'message', senderId: 'sender', senderName: 'Sender' },
      { kind: 'goal', goalId: 'goal', revision: 1, round: 1 },
      { kind: 'skill-invocation', name: 'skill', form: 'instructions' },
      { kind: 'skill-catalog', form: 'catalog', update: true, entries: [{ name: 'skill', description: 'Skill' }] },
      { kind: 'skill-catalog', form: 'catalog', entries: [] },
      { kind: 'coordinator', form: 'relay', senderSessionId: 'parent' },
      { kind: 'subagent-report', form: 'relay', senderSessionId: 'child' },
      { kind: 'subagent-settled', form: 'notice', summary: 'settled', senderSessionId: 'child' },
      {
        kind: 'webhook', provider: 'github', source: 'repo', deliveryId: 'delivery', ruleId: 'rule',
        form: 'notice', summary: 'push',
      },
    ]
    for (const [index, source] of sources.entries()) {
      const message = { id: `source-${index}`, role: 'user', content: [textBlock], source }
      expect(() => { assertPayload('user/message', message) }).not.toThrow()
    }

    const blocks: SessionFormatJsonValue[] = [
      { type: 'reasoning', text: 'reasoning' },
      {
        type: 'image', attachment: {
          attachmentId: 'image', mediaType: 'image/png', bytes: 10, width: 2, height: 2, name: 'x.png',
          originalDimensions: { width: 4, height: 4 },
        },
      },
      {
        type: 'image', attachment: {
          attachmentId: 'minimal-image', mediaType: 'image/jpeg', bytes: 1, width: 1, height: 1,
        },
      },
      { type: 'tool-call', id: 'call', name: 'read', arguments: '{}' },
      { type: 'tool-result', toolCallId: 'call', content: [textBlock], isError: true },
    ]
    for (const [index, block] of blocks.entries()) {
      const message = { ...userMessage, id: `block-${index}`, content: [block] }
      expect(() => { assertPayload('user/message', message) }).not.toThrow()
    }

    const chunks: SessionFormatJsonValue[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'reasoning-delta', index: 0, text: 'r' },
      { type: 'tool-call-delta', index: 0, id: 'call', name: 'read', argumentsDelta: '{}' },
      { type: 'tool-call-delta', index: 0, id: 'call', argumentsDelta: '{}' },
      { type: 'block-end', index: 0, block: textBlock },
      { type: 'usage', usage: {
        inputTokens: 1, outputTokens: 2, totalTokens: 3, cacheReadTokens: 0,
        cacheWriteTokens: 0, reasoningTokens: 1,
      } },
      { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { id: 'response' }, blocks: [{}] } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
      { type: 'finish', reason: { kind: 'max-tokens' } },
      { type: 'finish', reason: { kind: 'aborted', failure: { message: 'abort', code: 'ABORT' } } },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'error', code: 'ERROR' } } },
    ]
    for (const chunk of chunks) {
      expect(() => { assertPayload('assistant/chunk', { turn: 1, step: 0, chunk }) }).not.toThrow()
    }

    const turnReasons: SessionFormatJsonValue[] = [
      { kind: 'blocked' }, { kind: 'max-tokens' }, { kind: 'interrupted' },
      { kind: 'aborted', reason: { kind: 'user' } },
      { kind: 'aborted', reason: { kind: 'parent' } },
      { kind: 'aborted', reason: { kind: 'disposed' } },
      { kind: 'aborted', reason: { kind: 'legacy' } },
      { kind: 'aborted', reason: { kind: 'hook', reason: 'hook' } },
      { kind: 'error', error: { message: 'error', code: 'ERROR', status: 500, providerRetryAfterMs: 1, requestId: 'id' } },
    ]
    for (const reason of turnReasons) {
      expect(() => { assertPayload('turn/end', { turn: 1, reason }) }).not.toThrow()
    }

    const remaining: Array<[string, SessionFormatJsonValue]> = [
      ['goal/change', { kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: 'g', revision: 2 }, clearedAt: 3 }],
      ['goal/change', {
        kind: 'goal/change', version: 1, operation: 'block',
        goal: {
          id: 'g', revision: 2, objective: 'x', phase: 'blocked', maxGoalRounds: 3,
          blockedReason: { code: 'waiting', message: 'Wait' },
        },
        roundsStarted: 1, createdAt: 1, updatedAt: 2,
      }],
      ['schedule/change', { version: 1, operation: 'create', schedule: { id: 'at', kind: 'at', prompt: 'x', scheduledAt: '2026-08-31T00:00:00.000Z' } }],
      ['schedule/change', { version: 1, operation: 'create', schedule: { id: 'every', kind: 'every', prompt: 'x', everySeconds: 300, scheduledAt: '2026-08-31T00:00:00.000Z' } }],
      ['schedule/change', { version: 1, operation: 'delete', id: 'at' }],
      ['schedule/change', { version: 1, operation: 'dispatch', id: 'every', acceptedAt: '2026-08-31T00:00:00.000Z' }],
      ['llm/retry', {
        retryId: 'r', turn: 1, step: 0, provider: 'p', mode: 'always', policyKey: 'k', retry: 1,
        delayMs: 0, failure: { message: 'x', code: 'X' },
      }],
      ['session/title', { title: 'User title', messageSeqs: [], source: { kind: 'user' } }],
      ['session/title', { title: 'Provider title', messageSeqs: [0], source: { kind: 'provider', provider: 'p', model: { provider: 'p', model: 'm' } } }],
      ['session/title', { title: 'Provider title', messageSeqs: [0], source: { kind: 'provider', provider: 'p' } }],
      ['subagent/descriptor', { mode: 'one-shot', version: 3, provider: 'p', label: 'child' }],
      ['subagent/descriptor', { mode: 'one-shot', version: 3, provider: 'p' }],
      ['subagent/descriptor', {
        mode: 'continuable', version: 3, provider: 'p', label: 'child', agentProvider: 'p', agentModel: 'm',
        agentReasoningEffort: 'high', persona: 'persona', toolFilter: { deny: ['write'] },
      }],
      ['subagent/descriptor', { mode: 'continuable', version: 3, provider: 'p', label: 'child' }],
      ['approval/asked', { id: 'approval', toolName: 'read' }],
      ['team/member', {
        version: 1, teamId: 'team',
        member: { id: 'm', name: 'm', description: 'd', provider: 'p', context: 'fork', phase: 'failed', error: 'failure' },
      }],
      ['team/task', {
        version: 1, teamId: 'team',
        task: { id: 'task-2', revision: 2, subject: 's', description: 'd', status: 'completed', ownerId: 'm', blockedBy: ['task-1'], writeScopes: [] },
      }],
      ['command/done', { commandId: 'c', kind: 'error', text: 'failed' }],
      ['compaction/end', { compactionId: 'c', sourceCommandId: 'command', turn: 1, error: 'failure' }],
    ]
    for (const [type, data] of remaining) {
      expect(() => { assertPayload(type, data) }, type).not.toThrow()
    }
  })

  it('validates legacy round-zero goal mutation messages', () => {
    const change = {
      kind: 'goal/change', version: 1, operation: 'clear',
      cleared: { id: 'goal', revision: 2 }, clearedAt: 3,
    }
    const content = [{
      type: 'text',
      text: `<goal_state>${JSON.stringify({ cleared: change.cleared, clearedAt: change.clearedAt })}</goal_state>`,
    }]
    const message = {
      id: 'legacy-goal', role: 'user', content,
      source: { kind: 'goal', goalId: 'goal', revision: 2, round: 0, change },
    }
    expect(() => { assertPayload('user/message', message) }).not.toThrow()
    expect(() => { assertPayload('user/message', {
      ...message, source: { ...message.source, round: 1 },
    }) }).toThrow(/round must be 0/)
    expect(() => { assertPayload('user/message', {
      ...message, source: { ...message.source, goalId: 'other' },
    }) }).toThrow(/does not match/)
    expect(() => { assertPayload('user/message', { ...message, content: [textBlock] }) })
      .toThrow(/content does not match/)
  })

  it('refuses malformed logical headers, cuts, event envelopes, and surface metadata', () => {
    const base = v1Artifact('turn/start', { turn: 1 })
    const invalidHeaders = [
      { ...base.header, version: 0 },
      { ...base.header, id: 1 },
      { ...base.header, createdAt: -1 },
      { ...base.header, isSeeded: 'yes' },
      { ...base.header, delegationDepth: -1 },
      { ...base.header, cwd: 1 },
      { ...base.header, parentSession: 1 },
      { ...base.header, agentPreset: 1 },
      { ...base.header, origin: 'other' },
    ]
    for (const header of invalidHeaders) {
      expect(() => { assertReleasedV1Artifact({ ...base, header } as never) }).toThrow()
    }
    expect(() => { assertReleasedV1Artifact({ ...base, inheritedEventCount: base.events.length + 1 }) }).toThrow(/exceeds/)
    expect(() => { assertReleasedV1Artifact({ ...base, inheritedEventCount: 1 }) }).toThrow(/unseeded/)

    const rawEvents: unknown[][] = [
      [{ type: 1, seq: 0, time: 1, data: {} }],
      [{ type: 'plugin/unknown', seq: 0, time: 1, data: {} }],
      [{ type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } }],
      [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 }, ignorable: false }],
      [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 }, surfaceOp: 'append' }],
    ]
    for (const events of rawEvents) {
      expect(() => { assertReleasedV1Artifact({ ...base, events } as never) }).toThrow()
    }

    const surfaceData = userMessage
    const surfaceVariants = [
      { sourceEventSeqs: 'bad', surfaceOp: 'append' },
      { sourceEventSeqs: [3], surfaceOp: 'append' },
      { sourceEventSeqs: [1, 1], surfaceOp: 'append' },
      { sourceEventSeqs: [], surfaceOp: 'append' },
      { surfaceOp: null },
      { surfaceOp: { op: 'append', start: 0, end: 1 } },
      { surfaceOp: { op: 'replace', start: 3, end: 1 } },
      { surfaceOp: { op: 'replace', start: 1, end: 3 } },
    ]
    for (const metadata of surfaceVariants) {
      const artifact = v1Artifact('user/message', surfaceData)
      artifact.events[3] = { ...artifact.events[3], ...metadata } as never
      expect(() => { assertReleasedV1Artifact(artifact) }).toThrow()
    }

    const assistant = v1Artifact('assistant/message', validPayloads['assistant/message'] as SessionFormatJsonValue)
    assistant.events[3] = { ...assistant.events[3], sourceEventSeqs: [], surfaceOp: 'append' } as never
    expect(() => { assertReleasedEventPayload(assistant.events[3] as SessionFormatEvent, 1) }).not.toThrow()
  })

  it('accepts remaining optional payload members', () => {
    const cases: Array<[string, SessionFormatJsonValue]> = [
      ['agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }],
      ['assistant/message', {
        turn: 1, step: 0, message: assistantMessage, interrupted: true,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      }],
      ['compaction/summary', {
        compactionId: 'c', sourceCommandId: 'command', summary: [textBlock],
        shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [0, 1], shadowedTokenCount: 2,
        provider: 'p', model: 'm', maxTokens: 10, usage: { inputTokens: 1, outputTokens: 1 },
        rawOutput: [textBlock], llmStreamCall: true,
      }],
      ['hook/invoked', { turn: 1, point: 'Stop', dialect: 'codex', matcher: '*', handlerId: 'h' }],
      ['hook/result', {
        turn: 1, point: 'Stop', handlerId: 'h', decision: 'pass', exitCode: -1,
        stderrSummary: 'stderr', durationMs: 1,
      }],
      ['request/header', {
        header: {
          config: { provider: 'p', model: 'm', temperature: 0.5, maxTokens: 5, stop: ['stop'] },
          system: '', tools: [],
        },
        reason: 'change', startsSeries: true,
      }],
    ]
    for (const [type, data] of cases) {
      expect(() => { assertPayload(type, data) }, type).not.toThrow()
    }
  })

  it('refuses every relationship-specific invalid payload branch', () => {
    const cases: Array<[string, SessionFormatJsonValue]> = [
      ['command/done', { commandId: 'c', kind: 'success', sourceEventSeq: 3 }],
      ['session/title-llm-request', {
        titleProvider: 'p', messageSeqs: [], route: { provider: 'p', model: 'm' },
        system: 's', messages: [userMessage], maxTokens: 1,
      }],
      ['session/title', { title: 't', messageSeqs: [0, 0], source: { kind: 'fallback' } }],
      ['tool/result', { turn: 1, step: 0, message: { ...toolMessage, content: [] } }],
      ['tool/result', {
        turn: 1, step: 0,
        message: { ...toolMessage, content: [{ type: 'text', text: 'not a result' }] },
      }],
      ['user/message', {
        ...userMessage,
        source: { kind: 'plugin', plugin: 'x', form: 'notice', summary: 'x', sections: [] },
      }],
      ['user/message', {
        ...userMessage,
        source: {
          kind: 'session-reference', form: 'recall', version: 1,
          references: [{
            sessionId: 's', label: 's', capturedThroughSeq: null, compacted: false,
            originalMessages: 1, retainedMessages: 1, omittedMessages: 0, omittedBytes: 0,
            truncated: false, inputIndex: 1,
          }],
        },
      }],
      ['user/message', {
        ...userMessage,
        source: { kind: 'plugin', plugin: 'x', form: 'snapshot', sections: [], summary: 'x' },
      }],
      ['user/message', {
        ...userMessage,
        source: { kind: 'plugin', plugin: 'compact' },
      }],
      ['assistant/chunk', {
        turn: 1, step: 0, chunk: { type: 'finish', reason: { kind: 'stop' }, replayState: { response: {}, blocks: {} } },
      }],
      ['compaction/summary', {
        compactionId: 'c', summary: [], shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0],
        shadowedTokenCount: 0, provider: 'p', model: 'm', llmStreamCall: true,
      }],
      ['hook/result', { turn: 1, point: 'Stop', handlerId: 'h', decision: 'pass', durationMs: -0.5 }],
      ['llm/retry', {
        retryId: 'r', turn: 1, step: 0, provider: 'p', mode: 'always', policyKey: 'k', retry: 1,
        maxRetries: 2, delayMs: 0, failure: { message: 'x', code: 'X' },
      }],
      ['session/title-llm-request', {
        titleProvider: 'p', messageSeqs: [0], route: { provider: 'p', model: 'm' },
        system: 's', messages: [userMessage], maxTokens: 0,
      }],
      ['request/header', {
        header: { config: { provider: 'p', model: 'm' }, adapterDefaults: { maxTokens: true } },
        reason: 'initial',
      }],
      ['compaction/prune', {
        shadowedRange: { start: 1, end: 0 }, shadowedSeqs: [0, 1], shadowedTokenCount: 1,
      }],
      ['compaction/prune', {
        shadowedRange: { start: 0, end: 2 }, shadowedSeqs: [0, 1], shadowedTokenCount: 1,
      }],
      ['goal/change', {
        kind: 'goal/change', version: 1, operation: 'create',
        goal: { id: 'g', revision: 1, objective: 'x', phase: 'active', maxGoalRounds: 1, blockedReason: { code: 'x', message: 'x' } },
        roundsStarted: 0, createdAt: 1, updatedAt: 1,
      }],
      ['schedule/change', { version: 1, operation: 'create', schedule: { id: 'x', kind: 'unknown', prompt: 'x', scheduledAt: 'x' } }],
      ['schedule/change', { version: 1, operation: 'create', schedule: { id: 'x', kind: 'every', prompt: 'x', everySeconds: 299, scheduledAt: '2026-08-31T00:00:00.000Z' } }],
      ['schedule/change', { version: 1, operation: 'delete', id: ' x ' }],
      ['schedule/change', { version: 1, operation: 'dispatch', id: 'x', acceptedAt: '2026-02-31T00:00:00.000Z' }],
      ['subagent/descriptor', { mode: 'continuable', version: 3, provider: 'p', label: 'x', agentProvider: 'p' }],
      ['subagent/descriptor', { mode: 'continuable', version: 3, provider: 'p', label: 'x', toolFilter: {} }],
      ['subagent/model-selection-policy', { allowedModels: [{ provider: 'p', model: 'm' }, { provider: 'p', model: 'm' }] }],
      ['subagent/model-selection-policy', { allowedModels: [] }],
      ['user/message', {
        ...userMessage,
        source: {
          kind: 'session-reference', form: 'recall', version: 1,
          references: [{
            sessionId: 's', label: 's', capturedFormatVersion: 2, capturedThroughSeq: null,
            compacted: false, originalMessages: 1, retainedMessages: 1, omittedMessages: 0,
            omittedBytes: 0, truncated: false, inputIndex: 0,
          }],
        },
      }],
      ['user/message', {
        ...userMessage,
        source: {
          kind: 'session-reference', form: 'recall', version: 1,
          references: [{
            sessionId: 's', label: 's', capturedThroughSeq: null, compacted: false,
            originalMessages: 2, retainedMessages: 1, omittedMessages: 1, omittedBytes: 0,
            truncated: false, inputIndex: 0,
          }],
        },
      }],
      ['user/message', { ...userMessage, source: { kind: 'session-reference', form: 'recall', version: 1, references: [] } }],
      ['user/message', {
        ...userMessage,
        source: {
          kind: 'session-reference', form: 'recall', version: 1,
          references: [0, 1].map(inputIndex => ({
            sessionId: 'same', label: 's', capturedThroughSeq: null, compacted: false,
            originalMessages: 1, retainedMessages: 1, omittedMessages: 0, omittedBytes: 0,
            truncated: false, inputIndex,
          })),
        },
      }],
      ['web/deepseek-search-llm-request', {
        endpoint: 'x', apiVersion: 'x',
        body: { model: 'm', max_tokens: 1, messages: [{ role: 'user', content: [] }], tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }] },
      }],
      ['web/deepseek-search-llm-request', {
        endpoint: 'x', apiVersion: 'x',
        body: { model: 'm', max_tokens: 1, messages: [], tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }] },
      }],
      ['web/deepseek-search-llm-request', {
        endpoint: 'x', apiVersion: 'x',
        body: { model: 'm', max_tokens: 1, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], tools: [] },
      }],
    ]
    for (const [index, [type, data]] of cases.entries()) {
      expect(() => { assertPayload(type, data) }, `${type}-${index}`).toThrow()
    }
  })
})
