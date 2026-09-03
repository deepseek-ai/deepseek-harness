import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { scanLog } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import {
  buildVfsExampleFiles,
  VFS_EXAMPLE_OLDEST_MESSAGE,
  VFS_EXAMPLE_ROOT,
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
  return scanLog(readFileSync(
    join(VFS_EXAMPLE_ROOT, 'home/sessions/--dsh-workspace--', id, 'session.jsonl'),
  ))
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
  it('matches its deterministic source byte for byte', () => {
    const expected = buildVfsExampleFiles()
    expect(filesUnder(VFS_EXAMPLE_ROOT)).toEqual([...expected.keys()].sort())
    for (const [path, content] of expected) {
      expect(readFileSync(join(VFS_EXAMPLE_ROOT, path), 'utf8'), path).toBe(content)
    }
  })

  it('seeds the cold-list title cache against the main log identity', () => {
    const cache = JSON.parse(readFileSync(
      join(VFS_EXAMPLE_ROOT, 'home/storages/session_projcache.json'),
      'utf8',
    )) as {
      unit: { name: string; version: number }
      tables: {
        sessions: Record<string, {
          identity: { createdAt: number; cwd: string; isSeeded: boolean; inheritedEventCount: number }
          rows: { title: unknown }
        }>
      }
    }
    expect(cache.unit).toEqual({ name: 'session_projcache', version: 6 })
    expect(cache.tables.sessions[VFS_EXAMPLE_SESSION_IDS.main]).toMatchObject({
      identity: {
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
    expect(events.some(event => event.type === 'tool/result' && event.data.message.content[0].isError === true)).toBe(true)
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
      )).not.toThrow()
    }
  })
})
