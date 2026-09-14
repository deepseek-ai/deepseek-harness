/**
 * RemoteMock scenario for built-client tests that do not own a Host.
 * The adjacent JSON is maintained with this module when Remote responses or
 * the current Session header version change.
 * Fixture Sessions have no retained Host terminals to restore.
 */

import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ok, RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { remoteDefaultResponses } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/remote-default-responses.ts'

interface SessionSummary {
  readonly sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  readonly parentSessionId?: string
  readonly origin?: 'subagent'
  readonly cwd?: string
  readonly projections?: {
    readonly asOfSeq: number
    readonly values: Readonly<Record<string, unknown>>
  }
}

interface WorkspaceView {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  sessionIds: string[]
  readonly createdAt: string
  updatedAt: string
}

interface EventRecord {
  readonly type: 'event'
  readonly event: {
    readonly seq: number
    readonly time: number
    readonly type: string
    readonly data: unknown
    readonly surfaceOp?: string
  }
}

interface FollowSnapshot {
  readonly type: 'snapshot'
  readonly header: Readonly<Record<string, unknown>>
  readonly cursor: number
  readonly records: readonly EventRecord[]
  readonly hasMore: boolean
  readonly projections: Readonly<Record<string, unknown>>
  readonly assistantStream?: Readonly<Record<string, unknown>>
}

interface ControlBaseline {
  readonly type: 'baseline'
  readonly value: {
    readonly queues: Readonly<Record<string, readonly unknown[]>>
    readonly jobs: Readonly<Record<string, readonly unknown[]>>
    readonly approvals: readonly unknown[]
    readonly questions: readonly unknown[]
    readonly projections: Readonly<Record<string, {
      readonly asOfSeq: number
      readonly values: Readonly<Record<string, unknown>>
    }>>
  }
}

interface CapturedFixture {
  readonly sessionList: { readonly ok: true; readonly value: { readonly items: readonly SessionSummary[] } }
  readonly settingsDescribe: unknown
  readonly credentialsDescribe: unknown
  readonly modelCatalog: unknown
  readonly agentPresets: unknown
  readonly commands: unknown
  readonly workspace: {
    readonly type: 'baseline'
    readonly value: {
      readonly items: readonly WorkspaceView[]
      readonly archivedSessionIds: readonly string[]
    }
  }
  readonly control: ControlBaseline
  readonly remoteEvents: readonly unknown[]
  readonly follow: FollowSnapshot
  readonly attachment: unknown
}

export interface AssembledRemoteOptions {
  /** Return the fixture's image-dimension admission error from Session prompt. */
  readonly rejectPrompt?: boolean
}

export interface AssembledRemote {
  readonly mock: RemoteMock
}

const fixtureSource = readFileSync(
  join(process.cwd(), 'apps/web/tests/fixtures/assembled-remote.fixture.json'),
  'utf8',
)

/** Create one isolated RemoteMock world for an assembled built-client case. */
export function createAssembledRemote(options: AssembledRemoteOptions = {}): AssembledRemote {
  const fixture = JSON.parse(fixtureSource) as CapturedFixture
  const sessions = [...structuredClone(fixture.sessionList.value.items)]
  const workspaces = [...structuredClone(fixture.workspace.value.items)]
  const records = new Map<string, EventRecord[]>([[
    'fx-alpha',
    structuredClone(fixture.follow.records) as EventRecord[],
  ]])
  const nextTurns = new Map([...records].map(([sessionId, sessionRecords]) => {
    let next = 0
    for (const { event } of sessionRecords) {
      if (event.type !== 'turn/start' || !isRecord(event.data)) continue
      const turn = event.data['turn']
      if (typeof turn === 'number') next = Math.max(next, turn + 1)
    }
    return [sessionId, next] as const
  }))
  const attachments = new Map<string, unknown>([['fixture:image', structuredClone(fixture.attachment)]])
  const blankSessionProjections = fixture.control.value.projections['fx-gamma']
  if (blankSessionProjections === undefined) {
    throw new Error('assembled fixture: blank Session projections missing')
  }
  let nextSession = 1

  const mock = RemoteMock.create().load(remoteDefaultResponses)
  mock.load({
    unary: {
      'settings/describe': structuredClone(fixture.settingsDescribe),
      'credentials/describe': structuredClone(fixture.credentialsDescribe),
      'session/modelCatalog': structuredClone(fixture.modelCatalog),
      'agentPresets/list': structuredClone(fixture.agentPresets),
      'commands/list': structuredClone(fixture.commands),
      'settings/canOpenAgentPresetDirectory': ok(true),
      'settings/openSettingsDocument': ok({ opened: true }),
      'settings/openAgentPresetDirectory': ok({ opened: true }),
      'subagents/list': ok({ entries: [], parentAvailable: true }),
      'terminal/list': ok([]),
      'skills/list': ok({ skills: [] }),
      'session/canOpenWorkspacePath': ok(true),
      'session/openWorkspacePath': ok({ opened: true }),
      'session/updateQueue': {
        ok: false,
        error: {
          code: 'session/queue-item-not-found',
          message: 'assembled fixture has no pending queue item',
          details: {},
        },
      },
      'session/cancel': ok({ accepted: true }),
    },
  })

  mock.stream('$events', (_args, stream) => {
    for (const frame of fixture.remoteEvents) stream.push(structuredClone(frame))
  })
  mock.stream('session/control', (_args, stream) => {
    stream.push(structuredClone(fixture.control))
  })
  mock.stream('workspace/follow', (_args, stream) => {
    stream.push({
      type: 'baseline',
      value: {
        items: structuredClone(workspaces),
        archivedSessionIds: structuredClone(fixture.workspace.value.archivedSessionIds),
      },
    })
  })
  mock.stream('session/follow', ([args], stream) => {
    const request = recordValue(args, 'request')
    const sessionId = followedSessionId(request)
    if (sessionId === 'fx-alpha') {
      stream.push(structuredClone(fixture.follow))
      return
    }
    const summary = sessions.find(candidate => candidate.sessionId === sessionId)
    if (summary === undefined) throw new Error(`assembled fixture: no Session ${sessionId}`)
    const sessionRecords = records.get(sessionId) ?? []
    stream.push({
      type: 'snapshot',
      header: {
        version: 3,
        id: sessionId,
        createdAt: summary.updatedAt,
        cwd: summary.cwd,
        isSeeded: false,
      },
      cursor: sessionRecords.at(-1)?.event.seq ?? -1,
      records: structuredClone(sessionRecords),
      hasMore: false,
      projections: structuredClone(blankSessionProjections),
      ...isAssistantStreamRequested(request) ? { assistantStream: { revision: 0 } } : {},
    })
  })

  mock.unary('$events/result', (result: unknown) => {
    const eventId = recordString(result, 'eventId')
    mock.streams.push('$events', { type: 'cancel', eventId })
    return ok(undefined)
  })
  mock.unary('session/list', () => ok({ items: structuredClone(sessions) }))
  mock.unary('workspace/create', (request: unknown) => {
    const path = recordString(recordValue(request, 'request'), 'path')
    const existing = workspaces.find(workspace => workspace.path === path)
    if (existing !== undefined) return ok({ workspace: structuredClone(existing), created: false })
    const now = new Date().toISOString()
    const workspace = {
      workspaceId: `fx-ws-${String(workspaces.length + 1)}`,
      path,
      title: path.split('/').filter(Boolean).at(-1) ?? path,
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    }
    workspaces.unshift(workspace)
    mock.streams.push('workspace/follow', { type: 'upsert', workspace: structuredClone(workspace) })
    return ok({ workspace: structuredClone(workspace), created: true })
  })
  mock.unary('session/create', (request: unknown) => {
    request = recordValue(request, 'request')
    const requestedId = optionalRecordString(request, 'sessionId')
    const sessionId = requestedId ?? `fx-${String(nextSession++)}`
    const existing = sessions.find(candidate => candidate.sessionId === sessionId)
    if (existing !== undefined) return ok({ sessionId })
    const workspaceId = optionalRecordString(request, 'workspaceId')
    const workspace = workspaces.find(candidate => candidate.workspaceId === workspaceId)
    const cwd = workspace?.path ?? optionalRecordString(request, 'cwd') ?? '/tmp/fixture'
    const summary: SessionSummary = {
      sessionId,
      updatedAt: Date.now(),
      running: false,
      blank: true,
      cwd,
      projections: structuredClone(blankSessionProjections),
    }
    sessions.push(summary)
    records.set(sessionId, [])
    nextTurns.set(sessionId, 0)
    if (workspace !== undefined && !workspace.sessionIds.includes(sessionId)) {
      workspace.sessionIds = [sessionId, ...workspace.sessionIds]
      workspace.updatedAt = new Date().toISOString()
      mock.streams.push('workspace/follow', {
        type: 'upsert',
        workspace: structuredClone(workspace),
      })
    }
    mock.streams.push('$events', { type: 'emit', event: 'api-session/added', args: [structuredClone(summary)] })
    return ok({ sessionId })
  })
  mock.unary('session/attachment', (request: unknown) => {
    request = recordValue(request, 'request')
    const attachmentId = recordString(request, 'attachmentId')
    return attachments.get(attachmentId) ?? {
      ok: false,
      error: {
        code: 'session/attachment-invalid',
        message: `assembled fixture attachment ${attachmentId} is missing`,
        details: { reason: 'ATTACHMENT_NOT_FOUND' },
      },
    }
  })
  mock.unary('session/prompt', (request: unknown) => {
    request = recordValue(request, 'request')
    if (options.rejectPrompt === true) {
      return {
        ok: false,
        error: {
          code: 'session/attachment-invalid',
          message: 'assembled fixture: image side exceeds the deployment limit',
          details: { reason: 'IMAGE_DIMENSION_TOO_LARGE' },
        },
      }
    }
    const sessionId = recordString(request, 'sessionId')
    const requestId = recordString(request, 'requestId')
    const sessionRecords = records.get(sessionId) ?? []
    const summary = sessions.find(candidate => candidate.sessionId === sessionId)
    if (summary === undefined) throw new Error(`assembled fixture: no Session ${sessionId}`)
    const content = recordArray(request, 'content').map((part) => {
      if (!isRecord(part) || part.type !== 'image') return part
      const attachmentId = `assembled:${randomUUID()}`
      const data = recordString(part, 'data')
      const attachment = {
        attachmentId,
        mediaType: recordString(part, 'mediaType'),
        bytes: Math.max(1, Math.floor(data.length * 3 / 4)),
        width: 160,
        height: 90,
        ...optionalRecordString(part, 'name') === undefined
          ? {}
          : { name: optionalRecordString(part, 'name') },
      }
      attachments.set(attachmentId, ok({ attachment, data }))
      return { type: 'image', attachment }
    })
    const turn = nextTurns.get(sessionId) ?? 0
    nextTurns.set(sessionId, turn + 1)
    summary.updatedAt = Date.now()
    summary.blank = false
    if (!summary.running) {
      summary.running = true
      mock.streams.push('$events', { type: 'emit', event: 'api-session/status', args: [sessionId, true] })
    }
    const turnEvent = eventOf(sessionRecords.length, 'turn/start', { turn })
    const userEvent = eventOf(sessionRecords.length + 1, 'user/message', {
      content,
      source: { kind: 'user', rpcId: requestId },
      role: 'user',
      id: randomUUID(),
    }, 'append')
    sessionRecords.push(turnEvent, userEvent)
    records.set(sessionId, sessionRecords)
    mock.streams.push('session/follow', turnEvent, follows(sessionId))
    mock.streams.push('session/follow', userEvent, follows(sessionId))
    return ok({ accepted: true })
  })
  mock.unary('commands/execute', (args: unknown) => {
    const line = optionalRecordString(args, 'line') ?? ''
    const name = /^\/(\S+)/u.exec(line.trim())?.[1]
    if (name === undefined || !['compact', 'echo', 'goal', 'permission', 'plan'].includes(name)) {
      return ok(undefined)
    }
    return ok({
      commandId: `assembled-command-${randomUUID()}`,
      result: {
        kind: 'success',
        ...name === 'echo' ? { text: line.replace(/^\/echo\s*/u, '') } : {},
      },
    })
  })

  return { mock }
}

function eventOf(
  seq: number,
  type: string,
  data: unknown,
  surfaceOp?: string,
): EventRecord {
  return {
    type: 'event',
    event: {
      seq,
      time: Date.now(),
      type,
      data,
      ...(surfaceOp === undefined ? {} : { surfaceOp }),
    },
  }
}

function follows(sessionId: string): (args: readonly unknown[]) => boolean {
  return ([args]) => followedSessionId(recordValue(args, 'request')) === sessionId
}

function followedSessionId(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.address)) throw new TypeError('assembled fixture follow request is invalid')
  return value.address.kind === 'session'
    ? recordString(value.address, 'sessionId')
    : recordString(value.address, 'childSessionId')
}

function isAssistantStreamRequested(value: unknown): boolean {
  return isRecord(value) && value.assistantStream === true
}

function recordString(value: unknown, key: string): string {
  const selected = isRecord(value) ? value[key] : undefined
  if (typeof selected !== 'string') throw new TypeError(`assembled fixture ${key} must be a string`)
  return selected
}

function optionalRecordString(value: unknown, key: string): string | undefined {
  const selected = isRecord(value) ? value[key] : undefined
  if (selected === undefined) return undefined
  if (typeof selected !== 'string') throw new TypeError(`assembled fixture ${key} must be a string`)
  return selected
}

function recordArray(value: unknown, key: string): readonly unknown[] {
  const selected = isRecord(value) ? value[key] : undefined
  if (!Array.isArray(selected)) throw new TypeError(`assembled fixture ${key} must be an array`)
  return selected
}

function recordValue(value: unknown, key: string): unknown {
  if (!isRecord(value) || !(key in value)) throw new TypeError(`assembled fixture ${key} is missing`)
  return value[key]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
