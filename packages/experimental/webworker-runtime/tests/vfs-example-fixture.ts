/** Deterministic source for the filesystem tree bundled into the WebWorker preview. */

import { fileURLToPath } from 'node:url'
import {
  SessionId,
  SessionLogOffset,
  SessionSeq,
  type SessionEvent,
  type SessionHeader,
  type SessionLogOffset as SessionLogOffsetType,
  type SessionSeq as SessionSeqType,
} from '@deepseek-ai/dsh-session'
import {
  eventLines, projectKey, toHeaderLine,
} from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'

/** Root copied by the preview image's repository adapter. */
export const VFS_EXAMPLE_ROOT = fileURLToPath(new URL('./fixtures/vfs-example', import.meta.url))

/** Durable ids used by browser assertions and subagent parent links. */
export const VFS_EXAMPLE_SESSION_IDS = {
  main: SessionId('preview-showcase'),
  oneShot: SessionId('preview-architecture-review'),
  continuable: SessionId('preview-follow-up-builder'),
} as const

/** Stable title rendered in the root Session list. */
export const VFS_EXAMPLE_TITLE = 'WebWorker Preview Showcase'

/** Oldest prompt, intentionally outside the first 50-message history page. */
export const VFS_EXAMPLE_OLDEST_MESSAGE = 'History checkpoint 01: verify deterministic preview state.'

/** Settled tail marker used by browser acceptance and the demonstration GIF. */
export const VFS_EXAMPLE_TAIL_MESSAGE = 'Preview tour complete'

const WORKSPACE = '/dsh/workspace'
const CREATED_AT = 1_787_472_000_000
const HISTORICAL_TURNS = 28

const PREVIEW_GUIDE = `# Preview Workspace

This deterministic workspace is bundled with the browser-only preview.

- \`src/preview.ts\` is the file changed by the example write result.
- \`data/tasks.json\` mirrors the completed preview checklist.
- \`.agents/skills/preview-tour/SKILL.md\` proves dot directories survive image packing.

Refresh the preview to restore these image bytes.
`

const PREVIEW_SOURCE_BEFORE = 'export const previewStatus = \'draft\'\n'

const PREVIEW_SOURCE = `export const previewStatus = 'ready'

export const previewFeatures = ['tools', 'subagents', 'pagination'] as const
`

const TASKS = `${JSON.stringify({
  title: 'Preview verification',
  tasks: [
    { name: 'Inspect tool cards', status: 'completed' },
    { name: 'Open both subagents', status: 'completed' },
    { name: 'Load earlier history', status: 'completed' },
  ],
}, null, 2)}\n`

const SKILL = `---
name: preview-tour
description: Inspect the bundled Preview workspace and its deterministic Session examples.
---

# Preview tour

Read the workspace files, inspect the tool gallery, open both subagent histories, and load the earlier conversation page.
`

interface EventDraft {
  readonly type: string
  readonly data: unknown
  readonly surfaceOp?: 'append'
  readonly sourceEventSeqs?: SessionSeqType[]
  readonly ignorable?: true
}

class EventLog {
  readonly events: SessionEvent[]
  private nextTime: number

  constructor(time: number, seed: readonly SessionEvent[] = []) {
    this.events = seed.map(event => structuredClone(event))
    this.nextTime = Math.max(time, (this.events.at(-1)?.time ?? time - 1) + 1)
  }

  add(draft: EventDraft): SessionSeqType {
    const seq = SessionSeq(this.events.length)
    this.events.push({ ...draft, seq, time: this.nextTime++ } as unknown as SessionEvent)
    return seq
  }
}

function userMessage(id: string, text: string): EventDraft {
  return {
    type: 'user/message',
    data: {
      id,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  }
}

function assistantMessage(id: string, turn: number, step: number, content: unknown[]): EventDraft {
  return {
    type: 'assistant/message',
    data: {
      turn,
      step,
      message: {
        id,
        role: 'assistant',
        content,
        source: { kind: 'model', provider: 'preview-fixture', model: 'deterministic' },
      },
    },
    sourceEventSeqs: [],
    surfaceOp: 'append',
  }
}

interface GalleryCall {
  readonly id: string
  readonly name: string
  readonly args: Record<string, unknown>
  readonly result: string
  readonly meta?: unknown
  readonly error?: { readonly name: string; readonly code: string }
  readonly todos?: Array<{ readonly content: string; readonly status: 'pending' | 'in_progress' | 'completed' }>
}

function readResult(): { text: string; meta: unknown } {
  const lines = PREVIEW_GUIDE.trimEnd().split('\n').map((text, index) => ({ number: index + 1, text }))
  return {
    text: `<path>PREVIEW.md</path>\n<type>file</type>\n<content>\n${lines.map(line => `${String(line.number)}: ${line.text}`).join('\n')}\n\n(End of file - total ${String(lines.length)} lines)\n</content>`,
    meta: { path: 'PREVIEW.md', offset: 1, lines, totalLines: lines.length, lang: 'md' },
  }
}

function galleryCalls(): GalleryCall[] {
  const read = readResult()
  return [
    {
      id: 'preview-read',
      name: 'read',
      args: { file_path: 'PREVIEW.md' },
      result: read.text,
      meta: read.meta,
    },
    {
      id: 'preview-write',
      name: 'write',
      args: { file_path: 'src/preview.ts', content: PREVIEW_SOURCE },
      result: '<path>src/preview.ts</path>\n<type>file</type>\n<content>\nUpdated file\n</content>',
      meta: { diffs: [{ path: 'src/preview.ts', oldText: PREVIEW_SOURCE_BEFORE, newText: PREVIEW_SOURCE }] },
    },
    {
      id: 'preview-bash',
      name: 'bash',
      args: { command: "printf 'preview ready\\n'", description: 'Print the preview readiness marker' },
      result: 'preview ready\n',
    },
    {
      id: 'preview-glob',
      name: 'glob',
      args: { pattern: '**/*', path: '.' },
      result: 'PREVIEW.md\ndata/tasks.json\nsrc/preview.ts',
      meta: {
        shape: 'paths',
        paths: ['PREVIEW.md', 'data/tasks.json', 'src/preview.ts'],
        truncated: false,
        total: 3,
      },
    },
    {
      id: 'preview-grep',
      name: 'grep',
      args: { pattern: 'preview', path: '.', include: '*.{md,ts,json}' },
      result: 'PREVIEW.md:3:This deterministic workspace is bundled with the browser-only preview.\nsrc/preview.ts:1:export const previewStatus = \'ready\'',
      meta: {
        shape: 'matches',
        files: [
          { path: 'PREVIEW.md', matches: [{ lineNumber: 3, line: 'This deterministic workspace is bundled with the browser-only preview.' }] },
          { path: 'src/preview.ts', matches: [{ lineNumber: 1, line: "export const previewStatus = 'ready'" }] },
        ],
        truncated: false,
        total: 2,
      },
    },
    {
      id: 'preview-web-search',
      name: 'web_search',
      args: { queries: ['Web Worker filesystem compatibility'] },
      result: 'Browser workers can host deterministic in-memory filesystems.\n\nSources:\n1. MDN Web Workers API — https://developer.mozilla.org/docs/Web/API/Web_Workers_API',
      meta: {
        sources: [{
          url: 'https://developer.mozilla.org/docs/Web/API/Web_Workers_API',
          title: 'Web Workers API',
          snippet: 'Web Workers run scripts in background threads.',
        }],
        truncated: false,
        answer: 'Browser workers can host deterministic in-memory filesystems.',
      },
    },
    {
      id: 'preview-todo',
      name: 'todo_write',
      args: {
        todos: [
          { content: 'Inspect tool cards', status: 'completed' },
          { content: 'Open both subagents', status: 'completed' },
          { content: 'Load earlier history', status: 'in_progress' },
        ],
      },
      result: 'Updated todo list: 0 pending, 1 in progress, 2 completed.',
      todos: [
        { content: 'Inspect tool cards', status: 'completed' },
        { content: 'Open both subagents', status: 'completed' },
        { content: 'Load earlier history', status: 'in_progress' },
      ],
    },
    {
      id: 'preview-subagent',
      name: 'subagent',
      args: { description: 'Continue preview verification', prompt: 'Check the remaining preview cases.', run_in_background: true },
      result: `started subagent ${VFS_EXAMPLE_SESSION_IDS.continuable}`,
    },
    {
      id: 'preview-subagent-fork',
      name: 'subagent_fork',
      args: { description: 'Review preview architecture', prompt: 'Review the fixture architecture.', run_in_background: false },
      result: 'The preview fixture remains separate from user-owned WebFS data.',
    },
    {
      id: 'preview-failure',
      name: 'read',
      args: { file_path: 'missing.txt' },
      result: 'Error: ENOENT: no such file, open missing.txt',
      error: { name: 'FsError', code: 'ENOENT' },
    },
  ]
}

function addClosedTextTurn(log: EventLog, turn: number): void {
  const checkpoint = String(turn).padStart(2, '0')
  log.add({ type: 'turn/start', data: { turn } })
  log.add(userMessage(`preview-user-${checkpoint}`, `History checkpoint ${checkpoint}: verify deterministic preview state.`))
  if (turn === 1) {
    log.add({
      type: 'session/title',
      data: { title: VFS_EXAMPLE_TITLE, messageSeqs: [], source: { kind: 'user' } },
    })
  }
  log.add({ type: 'step/start', data: { turn, step: 1 } })
  log.add(assistantMessage(
    `preview-assistant-${checkpoint}`,
    turn,
    1,
    [{ type: 'text', text: `Checkpoint ${checkpoint} is recorded.` }],
  ))
  log.add({ type: 'step/end', data: { turn, step: 1 } })
  log.add({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
}

function mainLog(): {
  readonly events: SessionEvent[]
  readonly forkSeedLength: SessionLogOffsetType
} {
  const log = new EventLog(CREATED_AT)
  for (let turn = 1; turn <= HISTORICAL_TURNS; turn++) addClosedTextTurn(log, turn)
  const forkSeedLength = SessionLogOffset(log.events.length)
  const turn = HISTORICAL_TURNS + 1
  const calls = galleryCalls()

  log.add({ type: 'turn/start', data: { turn } })
  log.add(userMessage('preview-gallery-user', 'Show the seeded workspace, tool cards, subagents, and pagination in one tour.'))
  log.add({ type: 'step/start', data: { turn, step: 1 } })
  log.add(assistantMessage('preview-gallery-tools', turn, 1, [
    { type: 'reasoning', text: 'I will inspect the deterministic workspace and collect each preview surface.' },
    ...calls.map(call => ({ type: 'tool-call', id: call.id, name: call.name, arguments: JSON.stringify(call.args) })),
  ]))
  for (const call of calls) {
    log.add({
      type: 'tool/call',
      data: { turn, step: 1, callId: call.id, name: call.name, arguments: JSON.stringify(call.args) },
    })
    if (call.todos !== undefined) log.add({ type: 'todo/write', data: { todos: call.todos } })
    log.add({
      type: 'tool/result',
      data: {
        turn,
        step: 1,
        message: {
          id: `${call.id}-result`,
          role: 'user',
          content: [{
            type: 'tool-result',
            toolCallId: call.id,
            content: [{ type: 'text', text: call.result }],
            isError: call.error !== undefined,
          }],
          source: { kind: 'tool', callId: call.id },
        },
        ...call.meta === undefined ? {} : { meta: call.meta },
        ...call.error === undefined ? {} : { error: call.error },
      },
      surfaceOp: 'append',
    })
  }
  log.add({ type: 'step/end', data: { turn, step: 1 } })
  log.add({ type: 'step/start', data: { turn, step: 2 } })
  log.add(assistantMessage('preview-gallery-final', turn, 2, [{
    type: 'text',
    text: `## ${VFS_EXAMPLE_TAIL_MESSAGE}\n\nThe workspace, specialized tool cards, two subagent histories, and an earlier history page are ready to inspect.`,
  }]))
  log.add({ type: 'step/end', data: { turn, step: 2 } })
  log.add({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  return { events: log.events, forkSeedLength }
}

function oneShotLog(seed: readonly SessionEvent[]): SessionEvent[] {
  const log = new EventLog(CREATED_AT + 100_000, seed)
  log.add({ type: 'session/end-seed', data: {} })
  const turn = HISTORICAL_TURNS + 1
  log.add({ type: 'turn/start', data: { turn } })
  log.add(userMessage('preview-review-user', 'Review whether the preview fixture is isolated from future WebFS data.'))
  log.add({
    type: 'subagent/descriptor',
    data: snapshotSubagentDescriptor({
      mode: 'one-shot', provider: 'fork', label: 'Review preview architecture',
    }),
  })
  log.add({ type: 'step/start', data: { turn, step: 1 } })
  log.add(assistantMessage('preview-review-assistant', turn, 1, [{
    type: 'text',
    text: 'The bundled fixture is static image content; future WebFS state remains user-owned.',
  }]))
  log.add({ type: 'step/end', data: { turn, step: 1 } })
  log.add({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  return log.events
}

function continuableLog(): SessionEvent[] {
  const log = new EventLog(CREATED_AT + 200_000)
  log.add({ type: 'turn/start', data: { turn: 1 } })
  log.add(userMessage('preview-builder-user', 'Check that the Preview workspace can support follow-up tasks.'))
  log.add({
    type: 'subagent/descriptor',
    data: snapshotSubagentDescriptor({
      mode: 'continuable', provider: 'spawn', label: 'Continue preview verification',
    }),
  })
  log.add({ type: 'step/start', data: { turn: 1, step: 1 } })
  log.add(assistantMessage('preview-builder-assistant', 1, 1, [{
    type: 'text',
    text: 'This child is continuable and ready for another verification turn.',
  }]))
  log.add({ type: 'step/end', data: { turn: 1, step: 1 } })
  log.add({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  return log.events
}

function header(
  id: SessionHeader['id'],
  createdAt: number,
  child?: {
    readonly parentSession: SessionHeader['id']
    readonly mode: 'one-shot' | 'continuable'
    readonly seedLength?: SessionLogOffsetType
  },
): { readonly meta: SessionHeader; readonly inheritedEventCount: SessionLogOffsetType } {
  const inheritedEventCount = child?.seedLength ?? SessionLogOffset(0)
  return {
    meta: {
      version: 0,
      id,
      createdAt,
      cwd: WORKSPACE,
      isSeeded: child?.seedLength !== undefined,
      delegationDepth: child === undefined ? 0 : 1,
      agentPreset: 'standard',
      ...child === undefined ? {} : {
        parentSession: child.parentSession,
        origin: 'subagent' as const,
      },
    },
    inheritedEventCount,
  }
}

function renderLog(
  storage: { readonly meta: SessionHeader; readonly inheritedEventCount: SessionLogOffsetType },
  events: readonly SessionEvent[],
): string {
  return `${JSON.stringify(toHeaderLine(storage.meta, storage.inheritedEventCount))}\n${eventLines(events, true)}\n`
}

/** Build every committed fixture file as repository-relative UTF-8 text. */
export function buildVfsExampleFiles(): ReadonlyMap<string, string> {
  const main = mainLog()
  const project = projectKey(WORKSPACE)
  const sessionPath = (id: string): string => `home/sessions/${project}/${id}/session.jsonl`
  const projectionCache = `${JSON.stringify({
    unit: { name: 'session_projcache', version: 5 },
    global: null,
    tables: {
      sessions: {
        [VFS_EXAMPLE_SESSION_IDS.main]: {
          identity: {
            createdAt: CREATED_AT,
            cwd: WORKSPACE,
            isSeeded: false,
            inheritedEventCount: 0,
          },
          rows: {
            title: { ver: 1, seq: main.events.at(-1)?.seq ?? -1, val: VFS_EXAMPLE_TITLE },
          },
        },
      },
    },
  }, null, 2)}\n`
  return new Map([
    ['workspace/PREVIEW.md', PREVIEW_GUIDE],
    ['workspace/src/preview.ts', PREVIEW_SOURCE],
    ['workspace/data/tasks.json', TASKS],
    ['workspace/.agents/skills/preview-tour/SKILL.md', SKILL],
    ['home/storages/session_projcache.json', projectionCache],
    [sessionPath(VFS_EXAMPLE_SESSION_IDS.main), renderLog(
      header(VFS_EXAMPLE_SESSION_IDS.main, CREATED_AT),
      main.events,
    )],
    [sessionPath(VFS_EXAMPLE_SESSION_IDS.oneShot), renderLog(
      header(VFS_EXAMPLE_SESSION_IDS.oneShot, CREATED_AT + 100_000, {
        parentSession: VFS_EXAMPLE_SESSION_IDS.main,
        mode: 'one-shot',
        seedLength: main.forkSeedLength,
      }),
      oneShotLog(main.events.slice(0, main.forkSeedLength)),
    )],
    [sessionPath(VFS_EXAMPLE_SESSION_IDS.continuable), renderLog(
      header(VFS_EXAMPLE_SESSION_IDS.continuable, CREATED_AT + 200_000, {
        parentSession: VFS_EXAMPLE_SESSION_IDS.main,
        mode: 'continuable',
      }),
      continuableLog(),
    )],
  ])
}
