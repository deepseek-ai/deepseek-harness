import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { scheduleDomain } from '@deepseek-ai/dsh-schedule'
import { createSessionFormatCatalogWithChildren } from '@deepseek-ai/dsh-session-format-catalog'
import {
  generationLogFilename,
  scanLog,
} from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache'
import {
  buildVfsExampleFiles,
  VFS_EXAMPLE_OLDEST_MESSAGE,
  VFS_EXAMPLE_ROOT,
  VFS_EXAMPLE_REASONING,
  VFS_EXAMPLE_WRAPPED_COMMAND,
  VFS_EXAMPLE_SCHEDULE_IDS,
  VFS_EXAMPLE_SESSION_IDS,
  VFS_EXAMPLE_TAIL_MESSAGE,
  VFS_EXAMPLE_TITLE,
} from './vfs-example-fixture.ts'

function filesUnder(root: string): string[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.push(relative(root, path).replaceAll('\\', '/'))
    }
  }
  visit(root)
  return files.sort()
}

function readSession(id: string): ReturnType<typeof scanLog> {
  const path = `home/sessions/--dsh-workspace--/${id}/${generationLogFilename(SESSION_FORMAT_VERSION, 'none')}`
  const generated = buildVfsExampleFiles().get(path)
  if (generated === undefined) throw new Error(`missing generated VFS example Session ${path}`)
  return scanLog(Buffer.from(generated))
}

function restoreSession(content: string, version: number) {
  const [header, ...events] = content.trimEnd().split('\n').map(line => JSON.parse(line) as unknown)
  expect(header).toMatchObject({ type: 'session', version })
  const restore = createSessionFormatCatalogWithChildren([]).createRestore(header, { recovery: 'strict', validation: 'current' })
  for (const event of events) restore.decodeRow(event)
  return restore.finish()
}

function textOf(event: SessionEvent): string {
  if (event.type === 'user/message') {
    return event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  }
  if (event.type === 'assistant/message') {
    return event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  }
  return ''
}

describe('WebWorker preview VFS example', () => {
  it('keeps the current showcase and strictly restorable historical child inputs beside their predecessors', () => {
    const expected = buildVfsExampleFiles()
    const currentName = generationLogFilename(SESSION_FORMAT_VERSION, 'none')
    const main = `home/sessions/--dsh-workspace--/${VFS_EXAMPLE_SESSION_IDS.main}/`
    const committedPath = (path: string): string => path.endsWith(`/${currentName}`) && !path.startsWith(main)
      ? `${path.slice(0, -currentName.length)}session.v3.jsonl`
      : path
    const predecessors = Object.values(VFS_EXAMPLE_SESSION_IDS)
      .map(id => `home/sessions/--dsh-workspace--/${id}/session.v2.jsonl`)
    predecessors.push(`${main}session.v3.jsonl`)
    expect(filesUnder(VFS_EXAMPLE_ROOT)).toEqual([...expected.keys()].map(committedPath).concat(predecessors).sort())
    for (const [path, content] of expected) {
      const committed = readFileSync(join(VFS_EXAMPLE_ROOT, committedPath(path)), 'utf8')
      if (path.endsWith(`/${currentName}`) && !path.startsWith(main)) {
        expect(restoreSession(committed, 3), path).toEqual(restoreSession(content, SESSION_FORMAT_VERSION))
      } else {
        expect(committed, path).toBe(content)
        if (path.startsWith(main)) restoreSession(committed, SESSION_FORMAT_VERSION)
      }
    }
  })

  it('keeps the projection cache aligned with the current showcase writer and tail', () => {
    const committed = JSON.parse(readFileSync(
      join(VFS_EXAMPLE_ROOT, 'home/storages/session_projcache.json'),
      'utf8',
    )) as {
      unit: { name: string; version: number }
      tables: {
        sessions: Record<string, {
          identity: {
            formatVersion: number
            createdAt: number
            cwd: string
            isSeeded: boolean
            inheritedEventCount: number
          }
          rows: { title: unknown }
        }>
      }
    }
    const generatedText = buildVfsExampleFiles().get('home/storages/session_projcache.json')
    if (generatedText === undefined) throw new Error('missing generated VFS example projection cache')
    const generated = JSON.parse(generatedText) as typeof committed
    expect(generated).toEqual(committed)
    expect(generated.tables.sessions[VFS_EXAMPLE_SESSION_IDS.main]?.rows.title).toMatchObject({
      seq: readSession(VFS_EXAMPLE_SESSION_IDS.main).events.at(-1)?.seq,
    })
    expect(generated.unit).toEqual({
      name: projectionCacheDomainSpec.name,
      version: projectionCacheDomainSpec.version,
    })
    expect(generated.tables.sessions[VFS_EXAMPLE_SESSION_IDS.main]).toMatchObject({
      identity: {
        formatVersion: SESSION_FORMAT_VERSION,
        createdAt: 1_787_472_000_000,
        cwd: '/dsh/workspace',
        isSeeded: false,
        inheritedEventCount: 0,
      },
      rows: {
        title: {
          ver: 1,
          val: VFS_EXAMPLE_TITLE,
        },
      },
    })
  })

  it('seeds Host Schedule tasks the whole-unit domain accepts', () => {
    const path = 'home/storages/schedule.json'
    const text = buildVfsExampleFiles().get(path)
    if (text === undefined) throw new Error(`missing generated preview Schedule storage ${path}`)
    const document = JSON.parse(text) as {
      unit: { name: string; version: number }
      tables: { tasks: Record<string, unknown> }
    }
    expect(document.unit).toEqual({ name: scheduleDomain.name, version: scheduleDomain.version })
    for (const id of Object.values(VFS_EXAMPLE_SCHEDULE_IDS)) {
      const task = scheduleDomain.tables.tasks.valueSchema.parse(document.tables.tasks[id])
      expect(task.record.id).toBe(id)
      expect(task.record.title.trim().length).toBeGreaterThan(0)
      expect(task.status).toBe('active')
      expect(Date.parse(task.record.scheduledAt)).toBeGreaterThan(Date.now())
    }
  })

  it('restores the main production log with paging and tool coverage', () => {
    const { meta, inheritedEventCount, events } = readSession(VFS_EXAMPLE_SESSION_IDS.main)
    expect(meta).toMatchObject({
      id: VFS_EXAMPLE_SESSION_IDS.main,
      cwd: '/dsh/workspace',
      delegationDepth: 0,
      agentPreset: 'standard',
    })
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index))
    expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    expect(() => Session.fromRestore(
      SessionId(meta.id),
      events,
      meta,
      inheritedEventCount,
      'detached',
    )).not.toThrow()

    const messages = events.filter(event =>
      (event.type === 'user/message' || event.type === 'assistant/message') && event.surfaceOp === 'append')
    expect(messages.length).toBeGreaterThan(50)
    expect(messages.some(event => textOf(event).includes(VFS_EXAMPLE_OLDEST_MESSAGE))).toBe(true)
    expect(messages.some(event => textOf(event).includes(VFS_EXAMPLE_TAIL_MESSAGE))).toBe(true)
    expect(events.some(event => event.type === 'session/title'
      && (event.data as { title?: unknown }).title === VFS_EXAMPLE_TITLE)).toBe(true)

    const tools = events.flatMap(event => event.type === 'tool/call' ? [event.data.name] : [])
    expect(new Set(tools)).toEqual(new Set([
      'read', 'write', 'bash', 'glob', 'grep', 'web_search', 'todo_write', 'subagent', 'subagent_fork',
    ]))
    expect(events.some(event => event.type === 'todo/write')).toBe(true)
    expect(events.some(event => event.type === 'tool/result' && event.data.message.isError === true)).toBe(true)
  })

  it('preserves the 28-turn history prefix and both child catalog identities', () => {
    const main = readSession(VFS_EXAMPLE_SESSION_IDS.main)
    const child = readSession(VFS_EXAMPLE_SESSION_IDS.oneShot)
    const historical = restoreSession(readFileSync(join(VFS_EXAMPLE_ROOT,
      `home/sessions/--dsh-workspace--/${VFS_EXAMPLE_SESSION_IDS.main}/session.v3.jsonl`), 'utf8'), 3)
    const prefix = main.events.slice(0, child.inheritedEventCount)
    expect(prefix.filter(event => event.type === 'turn/start')).toHaveLength(28)
    expect(prefix).toEqual(historical.events.slice(0, child.inheritedEventCount))
    expect(child.events.slice(0, child.inheritedEventCount)).toEqual(prefix)
    expect(main.events.filter(event => event.type === 'subagent/catalog').map(event => event.data)).toEqual([
      { version: 0, childId: VFS_EXAMPLE_SESSION_IDS.oneShot, childCreatedAt: 1_787_472_100_000,
        mode: 'one-shot', label: 'Review preview architecture' },
      { version: 0, childId: VFS_EXAMPLE_SESSION_IDS.continuable, childCreatedAt: 1_787_472_200_000,
        mode: 'continuable', label: 'Continue preview verification' },
    ])
  })

  it('carries mixed reasoning, a wrapped command, and an authored parent-path link in the existing tour', () => {
    const { events } = readSession(VFS_EXAMPLE_SESSION_IDS.main)
    const gallery = events.find(event => event.type === 'assistant/message' && event.data.message.id === 'preview-gallery-tools')
    if (gallery?.type !== 'assistant/message') throw new Error('missing preview gallery message')
    const reasoning = gallery.data.message.content.flatMap(block => block.type === 'reasoning' ? [block.text] : [])
    expect(reasoning).toEqual(['', ' \t\n', VFS_EXAMPLE_REASONING[0], '', VFS_EXAMPLE_REASONING[1], '\n  '])
    expect(reasoning.filter(text => text.trim() !== '')).toEqual(VFS_EXAMPLE_REASONING)
    const call = events.find(event => event.type === 'tool/call' && event.data.callId === 'preview-wrapped-bash')
    if (call?.type !== 'tool/call') throw new Error('missing wrapped command call')
    expect(JSON.parse(call.data.arguments)).toEqual({
      command: VFS_EXAMPLE_WRAPPED_COMMAND, description: 'Show wrapped command and first-line status',
    })
    expect(VFS_EXAMPLE_WRAPPED_COMMAND.split('\n')[0]?.length).toBeGreaterThan(400)
    expect(VFS_EXAMPLE_WRAPPED_COMMAND.endsWith('\n')).toBe(true)
    expect(events.find(event => event.type === 'tool/result' && event.data.message.source.callId === 'preview-wrapped-bash'))
      .toMatchObject({ data: { message: { isError: false, content: [{ type: 'text', text: 'preview command fixture\nwrap complete\n[exit code: 0]' }] } } })
    const tail = events.findLast(event => event.type === 'assistant/message')
    if (tail === undefined) throw new Error('missing preview tour tail')
    expect(textOf(tail)).toContain(`## ${VFS_EXAMPLE_TAIL_MESSAGE}`)
    expect(textOf(tail)).toContain('[Parent workspace guide:1–8](<../workspace/PREVIEW.md#L1-L8>)')
    expect(textOf(tail)).toContain('fixture-authored demonstration data, not a live model run')
  })

  it('restores one-shot and continuable child Sessions with durable descriptors', () => {
    const expected = [
      [VFS_EXAMPLE_SESSION_IDS.oneShot, 'one-shot'],
      [VFS_EXAMPLE_SESSION_IDS.continuable, 'continuable'],
    ] as const
    for (const [id, mode] of expected) {
      const { meta, inheritedEventCount, events } = readSession(id)
      expect(meta).toMatchObject({
        id,
        cwd: '/dsh/workspace',
        parentSession: VFS_EXAMPLE_SESSION_IDS.main,
        origin: 'subagent',
        delegationDepth: 1,
        agentPreset: 'standard',
      })
      expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index))
      expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
      expect(foldSubagentDescriptor(events.slice(inheritedEventCount))).toMatchObject({ mode })
      expect(() => Session.fromRestore(
        SessionId(meta.id),
        events,
        meta,
        inheritedEventCount,
        'detached',
      )).not.toThrow()
    }
  })
})
