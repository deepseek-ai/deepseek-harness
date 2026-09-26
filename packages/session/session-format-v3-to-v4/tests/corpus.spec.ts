import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { createSessionFormatCatalogWithChildren, historicalSessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { isSessionFormatJsonObject, type SessionFormatArtifact, type SessionFormatEvent, type SessionFormatJsonObject, type SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { historicalChildCatalogSource } from '../src/index.ts'
import { mapEventMessages, rewritePluginSource } from '../src/sources.ts'
import { liftToolResult } from '../src/tool-role.ts'

const root = resolve(import.meta.dirname, '../../../..')

function restoreFixture(path: string): SessionFormatArtifact {
  const records = readFileSync(join(root, path), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, SessionFormatJsonValue>)
  const header = records.shift()!
  if (typeof header['cwd'] === 'string' && header['cwd'].startsWith('{{cwd}}')) header['cwd'] = resolve('snapshot-cwd')
  const restore = historicalSessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })
  for (const [seq, record] of records.entries()) {
    if (record['type'] === 'request/header' && isSessionFormatJsonObject(record['data']) && isSessionFormatJsonObject(record['data']['header'])) {
      const request = { ...record['data']['header'] }
      record['data'] = { ...record['data'], header: request }
      if (request['tools'] === '{{tools}}') delete request['tools']
      else if (Array.isArray(request['tools']) && request['tools'].every(tool => typeof tool === 'string')) {
        request['tools'] = request['tools'].map(name => ({ name, description: '', parameters: {} }))
      }
    }
    restore.decodeRow({ ...record, seq: record['seq'] ?? seq, time: record['time'] ?? 0 })
  }
  return restore.finish()
}

function migrate(parent: SessionFormatArtifact, children: SessionFormatArtifact[]) {
  const restore = createSessionFormatCatalogWithChildren(children.map(historicalChildCatalogSource)).createRestore({ type: 'session', ...parent.header }, {
    recovery: 'strict', validation: 'current',
  })
  for (const event of parent.events) restore.decodeRow(event)
  return restore.finish()
}

function migrateEvent(event: SessionFormatEvent): SessionFormatEvent {
  const rewritten = mapEventMessages(event, (message) => {
    const source = message['source']
    if (!isSessionFormatJsonObject(source) || source['kind'] !== 'plugin') return message
    return { ...message, source: rewritePluginSource(source, event.seq, message['role']) }
  })
  return liftToolResult(rewritten)
}

it('refuses recorded parent/child clock conflicts and migrates consistent copies including failed startup', () => {
  const conflicts: string[] = []
  let pairs = 0
  let withoutDescriptor = 0
  for (const profile of ['sdk', 'session']) {
    const base = `snapshots/${profile}`
    for (const dir of readdirSync(join(root, base), { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const names = readdirSync(join(root, base, dir.name)).filter(name => /^session(?:\.\d+)?\.v3\.jsonl$/.test(name))
      if (names.length < 2) continue
      const logs = names.map(name => ({ path: `${base}/${dir.name}/${name}`, artifact: restoreFixture(`${base}/${dir.name}/${name}`) }))
      for (const parent of logs) {
        const children = logs.filter(child => child.artifact.header.origin === 'subagent' && child.artifact.header.parentSession === parent.artifact.header.id)
        if (children.length === 0) continue
        pairs += children.length
        const catalogs = parent.artifact.events.filter(event => event.type === 'subagent/catalog' && event.seq >= parent.artifact.inheritedEventCount)
        const aligned = children.map((child) => {
          const catalog = catalogs.find(event => isSessionFormatJsonObject(event.data) && event.data['childId'] === child.artifact.header.id)?.data
          expect(isSessionFormatJsonObject(catalog), child.path).toBe(true)
          const createdAt = (catalog as SessionFormatJsonObject)['childCreatedAt'] as number
          if (createdAt !== child.artifact.header.createdAt) conflicts.push(child.path)
          if (historicalChildCatalogSource(child.artifact)['descriptorCount'] === 0) withoutDescriptor++
          // Only this detached control changes a clock; committed generations are immutable rejection evidence.
          return { ...child.artifact, header: { ...child.artifact.header, createdAt } }
        })
        if (children.some(child => conflicts.includes(child.path))) {
          expect(() => migrate(parent.artifact, children.map(child => child.artifact)), parent.path).toThrow('conflicts with its parent catalog')
        } else {
          expect(migrate(parent.artifact, children.map(child => child.artifact)).events, parent.path).toEqual(
            parent.artifact.events.map(migrateEvent),
          )
        }
        expect(migrate(parent.artifact, aligned), parent.path).toEqual({
          ...parent.artifact,
          header: { ...parent.artifact.header, version: 4 },
          events: parent.artifact.events.map(migrateEvent),
        })
      }
    }
  }
  expect(pairs).toBe(25)
  expect(withoutDescriptor).toBe(1)
  expect(conflicts.sort()).toEqual(EXPECTED_CONFLICTS)
})

const EXPECTED_CONFLICTS = [
  'snapshots/sdk/subagent-continuable-inheritance/session.1.v3.jsonl',
  'snapshots/sdk/subagent-continuable/session.1.v3.jsonl',
  'snapshots/sdk/subagent-fork-in-process/session.1.v3.jsonl',
  'snapshots/sdk/subagent-list-agents/session.1.v3.jsonl',
  'snapshots/sdk/subagent-mixed/session.1.v3.jsonl',
  'snapshots/sdk/subagent-mixed/session.2.v3.jsonl',
  'snapshots/sdk/subagent-send-message/session.1.v3.jsonl',
  'snapshots/sdk/subagent-spawn-in-process/session.1.v3.jsonl',
  'snapshots/session/advanced-toolchain-runtime/session.1.v3.jsonl',
  'snapshots/session/advanced-toolchain-runtime/session.2.v3.jsonl',
  'snapshots/session/advanced-toolchain/session.1.v3.jsonl',
  'snapshots/session/advanced-toolchain/session.2.v3.jsonl',
  'snapshots/session/ralph-loop/session.1.v3.jsonl',
  'snapshots/session/ralph-loop/session.2.v3.jsonl',
  'snapshots/session/subagent-child-question-rejection/session.1.v3.jsonl',
  'snapshots/session/subagent-depth-two-rejection/session.1.v3.jsonl',
  'snapshots/session/subagent-depth-two-rejection/session.2.v3.jsonl',
  'snapshots/session/subagent-max-tokens-partial/session.1.v3.jsonl',
  'snapshots/session/subagent-parallel/session.1.v3.jsonl',
  'snapshots/session/subagent-parallel/session.2.v3.jsonl',
  'snapshots/session/subagent-published-run-failure/session.1.v3.jsonl',
  'snapshots/session/subagent-spawn-in-process/session.1.v3.jsonl',
  'snapshots/session/subagent-tool-filter/session.1.v3.jsonl',
  'snapshots/session/workflow-run/session.1.v3.jsonl',
]
