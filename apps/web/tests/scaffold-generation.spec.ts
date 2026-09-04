import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertFixtureInventory,
  recordedSessionFixturePath,
  selectedSessionFixture,
} from './scaffold.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('Web snapshot generation filenames', () => {
  it('selects the highest parent and child generations without counting retained inputs twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-fixture-generations-'))
    roots.push(root)
    for (const [name, version] of [
      ['session.jsonl', 0],
      ['session.v2.jsonl', 2],
      ['session.1.jsonl', 0],
      ['session.1.v1.jsonl', 1],
    ] as const) {
      await writeFile(join(root, name), `${JSON.stringify({
        type: 'session', version, id: '{{session:1}}', createdAt: 0, delegationDepth: 0,
      })}\n`)
    }

    await expect(selectedSessionFixture(join(root, 'session.jsonl')))
      .resolves.toBe(join(root, 'session.v2.jsonl'))
    await expect(selectedSessionFixture(join(root, 'session.1.jsonl')))
      .resolves.toBe(join(root, 'session.1.v1.jsonl'))
    await expect(selectedSessionFixture(join(root, 'replay.override.json')))
      .resolves.toBe(join(root, 'replay.override.json'))
  })

  it('leaves an absent override-only parent fixture unresolved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-fixture-generations-'))
    roots.push(root)

    await expect(selectedSessionFixture(join(root, 'session.jsonl'), true))
      .resolves.toBe(join(root, 'session.jsonl'))
    await expect(selectedSessionFixture(join(root, 'session.jsonl')))
      .rejects.toThrow('missing parent session fixture')
  })

  it('records beside an older generation and preserves the parent or child role', () => {
    const fixtures = join('/', 'fixtures')
    expect(recordedSessionFixturePath(join(fixtures, 'session.jsonl'), 1))
      .toBe(join(fixtures, 'session.v1.jsonl'))
    expect(recordedSessionFixturePath(join(fixtures, 'session.2.jsonl'), 3))
      .toBe(join(fixtures, 'session.2.v3.jsonl'))
    expect(recordedSessionFixturePath(join(fixtures, 'session.v1.jsonl'), 1))
      .toBe(join(fixtures, 'session.v1.jsonl'))
    expect(() => recordedSessionFixturePath(join(fixtures, 'notes.jsonl'), 1))
      .toThrow('invalid Session fixture path')
  })

  it('treats retained generations as one exact inventory role', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-fixture-inventory-'))
    roots.push(root)
    await writeFile(join(root, 'session.jsonl'), `${JSON.stringify({
      type: 'session', version: 0, id: '{{session:1}}', createdAt: 0, delegationDepth: 0,
    })}\n`)
    await writeFile(join(root, 'session.v1.jsonl'), `${JSON.stringify({
      type: 'session', version: 1, id: '{{session:1}}', createdAt: 0, delegationDepth: 0,
    })}\n`)
    await writeFile(join(root, 'ui.expected.md'), 'stable\n')

    await expect(assertFixtureInventory(root, ['session.jsonl', 'ui.expected.md']))
      .resolves.toBeUndefined()
  })
})
