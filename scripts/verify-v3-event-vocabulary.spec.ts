import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RELEASED_V3_EVENT_TYPES } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { verifyV3EventVocabulary } from './verify-v3-event-vocabulary.ts'

const roots: string[] = []
const writerPath = 'packages/core/session/src/types.ts'
const eventsPath = 'packages/core/session/src/known-event-types.ts'
const names = [...RELEASED_V3_EVENT_TYPES]

function write(root: string, path: string, content: string): void {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

function git(root: string, args: readonly string[], environment: NodeJS.ProcessEnv = process.env): string {
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) =>
    !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key.toUpperCase())))
  return execFileSync('git', [
    '-c', 'user.name=V3 vocabulary fixture', '-c', 'user.email=v3-fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(root, 'empty-hooks')}`, ...args,
  ], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function fixture(options: { writer?: string; events?: string } = {}): { root: string; sourceRef: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v3-vocabulary-'))
  roots.push(root)
  write(root, writerPath, options.writer ?? 'export const SESSION_FORMAT_VERSION = 3 as const\n')
  write(root, eventsPath, options.events ?? `export const KNOWN_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set(${JSON.stringify(names)})\n`)
  git(root, ['init', '--quiet'])
  git(root, ['add', '.'])
  git(root, ['commit', '--quiet', '-m', 'V3 source fixture'])
  return { root, sourceRef: git(root, ['rev-parse', 'HEAD']) }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('explicit V3 source vocabulary verification', () => {
  it('keeps fixture writes inside their own repository despite inherited Git location variables', () => {
    const target = fixture()
    const foreign = fixture()
    write(target.root, 'target-only.txt', 'target')
    write(foreign.root, 'foreign-only.txt', 'foreign')
    const before = git(foreign.root, ['status', '--porcelain'])
    const environment = {
      ...process.env,
      GIT_DIR: join(foreign.root, '.git'),
      GIT_WORK_TREE: foreign.root,
      GIT_INDEX_FILE: join(foreign.root, '.git', 'foreign-index'),
    }
    git(target.root, ['add', '--all'], environment)
    git(target.root, ['commit', '--quiet', '-m', 'Target fixture update'], environment)
    expect(git(foreign.root, ['rev-parse', 'HEAD'])).toBe(foreign.sourceRef)
    expect(git(foreign.root, ['status', '--porcelain'])).toBe(before)
    expect(git(target.root, ['show', 'HEAD:target-only.txt'])).toBe('target')
    expect(environment.GIT_DIR).toBe(join(foreign.root, '.git'))
  })

  it('checks a pinned V3 writer independently of later V4 commits', () => {
    const { root, sourceRef } = fixture()
    write(root, writerPath, 'export const SESSION_FORMAT_VERSION = 4 as const\n')
    write(root, eventsPath, `export const KNOWN_SESSION_EVENT_TYPES = new Set(${JSON.stringify([...names, 'developer/message'])})\n`)
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'Later V4 writer with developer events'])
    expect(verifyV3EventVocabulary(root, sourceRef)).toEqual({ sourceRef, eventCount: names.length })
  })

  it('rejects new V3 names even when the target writer has not classified them yet', () => {
    const { root, sourceRef } = fixture({
      events: `export const KNOWN_SESSION_EVENT_TYPES = new Set(${JSON.stringify([...names, 'new-v3/required', 'new-v3/ignorable'])})\n`,
    })
    expect(() => verifyV3EventVocabulary(root, sourceRef)).toThrow('Missing V3 names: new-v3/ignorable, new-v3/required')
    expect(verifyV3EventVocabulary(root, sourceRef, new Set([...names, 'new-v3/required', 'new-v3/ignorable'])).eventCount)
      .toBe(names.length + 2)
  })

  it('rejects a V4 source instead of treating developer/message as a V3 event', () => {
    const { root, sourceRef } = fixture({
      writer: 'export const SESSION_FORMAT_VERSION = 4 as const\n',
      events: `export const KNOWN_SESSION_EVENT_TYPES = new Set(${JSON.stringify([...names, 'developer/message'])})\n`,
    })
    expect(() => verifyV3EventVocabulary(root, sourceRef)).toThrow('must be a V3 writer')
  })

  it('rejects a V4-only name accidentally copied into the migration-owned V3 set', () => {
    const { root, sourceRef } = fixture()
    expect(() => verifyV3EventVocabulary(root, sourceRef, new Set([...names, 'developer/message'])))
      .toThrow('Extra migration names: developer/message')
  })

  it.each(['HEAD', 'origin/master', 'dsh-v0.1.5-alpha.1', 'a'.repeat(10), '', '--help'])('rejects a mutable or incomplete source pin %j', (ref) => {
    expect(() => verifyV3EventVocabulary(tmpdir(), ref)).toThrow('full immutable commit id')
  })

  it('reports a source object missing from the local repository without fetching', () => {
    const { root } = fixture()
    expect(() => verifyV3EventVocabulary(root, '0'.repeat(40))).toThrow('not available locally')
  })

  it('rejects tree objects and reports missing generated files at the source pin', () => {
    const { root, sourceRef } = fixture()
    expect(() => verifyV3EventVocabulary(root, git(root, ['rev-parse', `${sourceRef}^{tree}`])))
      .toThrow('must name a commit object')
    git(root, ['rm', eventsPath])
    git(root, ['commit', '--quiet', '-m', 'Source without generated event inventory'])
    expect(() => verifyV3EventVocabulary(root, git(root, ['rev-parse', 'HEAD']))).toThrow('not available locally')
  })

  it('accepts harmless parentheses and reordered generated event names', () => {
    const { root, sourceRef } = fixture({
      writer: 'export const SESSION_FORMAT_VERSION = (3 as const)\n',
      events: `export const KNOWN_SESSION_EVENT_TYPES = (new Set(${JSON.stringify([...names].reverse())}))\n`,
    })
    expect(verifyV3EventVocabulary(root, sourceRef).eventCount).toBe(names.length)
  })

  it.each([
    'const SESSION_FORMAT_VERSION = 3\n',
    'export const SESSION_FORMAT_VERSION: number\n',
    'export const SESSION_FORMAT_VERSION = 3, SESSION_FORMAT_VERSION = 3\n',
    'export const SESSION_FORMAT_VERSION = "3"\n',
  ])('rejects an ambiguous or nonliteral writer declaration %j', (writer) => {
    const { root, sourceRef } = fixture({ writer })
    expect(() => verifyV3EventVocabulary(root, sourceRef)).toThrow()
  })

  it.each([
    'export const OTHER = new Set([])\n',
    'export const KNOWN_SESSION_EVENT_TYPES = []\n',
    'export const KNOWN_SESSION_EVENT_TYPES = new Map([])\n',
    'export const KNOWN_SESSION_EVENT_TYPES = new Set()\n',
    'export const KNOWN_SESSION_EVENT_TYPES = new Set(undefined)\n',
    'export const KNOWN_SESSION_EVENT_TYPES = new Set([...otherNames])\n',
    'export const KNOWN_SESSION_EVENT_TYPES = new Set([computeName()])\n',
    'export const KNOWN_SESSION_EVENT_TYPES = new Set(["duplicate", "duplicate"])\n',
  ])('rejects unsupported generated declarations without evaluating them: %j', (events) => {
    const { root, sourceRef } = fixture({ events })
    expect(() => verifyV3EventVocabulary(root, sourceRef)).toThrow()
  })
})
