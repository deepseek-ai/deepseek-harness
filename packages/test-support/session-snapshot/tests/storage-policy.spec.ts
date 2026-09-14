import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { sessionFixtureName } from '../src/session-files.ts'
import { assertSessionFixtureStorage } from '../src/suite.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const system = { type: 'system/message', data: { message: {
  role: 'system', content: [{ type: 'text', text: '{{system}}' }],
} } }
const request = { type: 'request/header', data: { header: { tools: '{{tools}}' } } }
const historicalRequest = { type: 'request/header', data: { header: { system: '{{system}}', tools: '{{tools}}' } } }

function fixture(id: number, version: number, events: unknown[]): string {
  return [{ type: 'session', version, id: `{{session:${id}}}`, createdAt: 0, delegationDepth: id - 1 }, ...events]
    .map(record => JSON.stringify(record)).join('\n') + '\n'
}

function registerGuard(childEvents: unknown[], historicalEvents?: unknown[]): () => Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-storage-policy-'))
  roots.push(root)
  const dir = join(root, 'pin')
  mkdirSync(dir)
  writeFileSync(join(dir, sessionFixtureName(0, SESSION_FORMAT_VERSION)), fixture(1, SESSION_FORMAT_VERSION, [system, request]))
  // Each role selects its highest generation; the older child predates system/message.
  writeFileSync(join(dir, 'session.1.v1.jsonl'), fixture(2, 1, [request]))
  writeFileSync(join(dir, sessionFixtureName(1, SESSION_FORMAT_VERSION)), fixture(2, SESSION_FORMAT_VERSION, childEvents))
  if (historicalEvents !== undefined) {
    writeFileSync(join(dir, 'session.2.jsonl'), [
      JSON.stringify({ type: 'session', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', createdAt: 0 }),
      ...historicalEvents.map(event => JSON.stringify(event)),
      '',
    ].join('\n'))
  }
  const contents = (): string[] => readdirSync(dir).sort().map(file => readFileSync(join(dir, file), 'utf8'))
  const before = contents()
  return async () => {
    await assertSessionFixtureStorage(dir, 'pin')
    expect(contents()).toEqual(before)
  }
}

test('checks only the highest generation of every parent and child role', async () => {
  await expect(registerGuard([system, request])()).resolves.toBeUndefined()
})

test('preserves a selected historical child without imposing current prompt or identity storage', async () => {
  await expect(registerGuard([system, request], [historicalRequest])()).resolves.toBeUndefined()
})

test.each([
  ['unknown tool', { type: 'tool/result', data: { error: { code: 'UNKNOWN_TOOL' } } }, 'contains UNKNOWN_TOOL'],
  ['noncanonical cwd', { type: 'user/message', data: { text: '/private{{cwd}}/file' } }, 'carries a non-canonical macOS cwd token'],
] as const)('rejects a selected historical child with %s', async (_name, event, message) => {
  await expect(registerGuard([system, request], [historicalRequest, event])()).rejects.toThrow(`pin/session.2.jsonl ${message}`)
})

test('rejects an unredacted identity in a selected current child beside historical residue', async () => {
  const unredacted = { ...system, data: { message: { ...system.data.message, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } } }
  await expect(registerGuard([unredacted, request], [historicalRequest])()).rejects.toThrow('identity redaction fixed point')
})

test.each([
  ['missing prompt', [request], 'has a request/header with no preceding system/message'],
  ['unscrubbed prompt', [{ ...system, data: { message: {
    role: 'system', content: [{ type: 'text', text: 'leaked child prompt' }],
  } } }, request], 'carries an unscrubbed system prompt'],
  ['unscrubbed tools', [system, { type: 'request/header', data: { header: { tools: [] } } }], 'carries unscrubbed tool schemas'],
] as const)('rejects a selected child with %s', async (_name, events, message) => {
  await expect(registerGuard([...events])()).rejects.toThrow(`pin/${sessionFixtureName(1, SESSION_FORMAT_VERSION)} ${message}`)
})
