/**
 * Tests for the event-relation collector's demand-driven call-site indexing:
 * the single-file fast path and the global fallback must recover the same
 * helper-parameter event names, including shapes that defeat the locality
 * proof (alias escapes and global script files). The filesystem-probe memo
 * must answer repeated probes from one result and restore `ts.sys`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'
import { collectPackageSources, EventRelationCollector, withMemoizedFileSystemProbes } from './gen-doc-graphs.ts'
import { TypeScriptProject } from './ts-project.ts'

const FIXTURE: Record<string, string> = {
  'tsconfig.host.json': JSON.stringify({
    compilerOptions: {
      target: 'es2022',
      module: 'esnext',
      moduleResolution: 'bundler',
      allowImportingTsExtensions: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    },
    include: ['vendor/**/*.ts', 'packages/**/*.ts'],
  }),
  'vendor/cordis/src/context.ts': 'export class Context { private brand!: void }\n',
  'vendor/cordis/src/events.ts': [
    'export class EventsService {',
    '  dispatch(type: string, args: unknown[]): unknown[] { return [type, args] }',
    '}',
    '',
  ].join('\n'),
  'packages/core/agent/src/dispatch.ts':
    'export interface AgentEventDispatch { emit(...args: unknown[]): void }\n',
  // fireLocal: every same-file reference is a direct callee, so the locality
  // proof holds and only this file is indexed. fireAliased: the exported
  // const is a value-position reference, so the proof fails and the global
  // fallback must find the cross-file call in pkgb.
  'packages/fix/pkga/src/index.ts': [
    "import { EventsService } from '../../../../vendor/cordis/src/events.ts'",
    'declare const events: EventsService',
    "function fireLocal(args: [string]): void { void events.dispatch('emit', args) }",
    "fireLocal(['pkga/local-event'])",
    "function fireAliased(args: [string]): void { void events.dispatch('emit', args) }",
    'export const aliased = fireAliased',
    '',
  ].join('\n'),
  'packages/fix/pkgb/src/index.ts': [
    "import { aliased } from '../../pkga/src/index.ts'",
    "aliased(['pkgb/aliased-event'])",
    '',
  ].join('\n'),
  // Global script files (no import/export): scriptFire is program-visible, so
  // the cross-file call in caller.ts leaves no same-file reference. Only the
  // module-ness premise check routes this helper to the global index; without
  // it the proof would pass and the event would silently drop.
  'packages/fix/pkgc/src/globals.ts':
    "declare var gEvents: import('../../../../vendor/cordis/src/events.ts').EventsService\n",
  'packages/fix/pkgc/src/helper.ts':
    "function scriptFire(args: [string]): void { void gEvents.dispatch('emit', args) }\n",
  'packages/fix/pkgc/src/caller.ts': "scriptFire(['pkgc/script-event'])\n",
}

const root = mkdtempSync(join(tmpdir(), 'gen-doc-graphs-'))
for (const [rel, content] of Object.entries(FIXTURE)) {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), content)
}
const project = new TypeScriptProject(root)
const sources = collectPackageSources(project)

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function dispatchersOf(pkgs: readonly string[], event: string): string[] {
  const subset = sources.filter(source => pkgs.includes(source.pkg))
  const relations = new EventRelationCollector(project, subset).collect()
  return [...(relations.get(event)?.dispatchers.keys() ?? [])]
}

describe('event relation call-site indexing', () => {
  it('recovers a proven-local helper through the single-file fast path', () => {
    expect(dispatchersOf(['pkga', 'pkgb'], 'pkga/local-event')).toEqual(['pkga'])
  })

  it('recovers an alias-escaped helper through the global fallback', () => {
    expect(dispatchersOf(['pkga', 'pkgb'], 'pkgb/aliased-event')).toEqual(['pkga'])
  })

  it('rejects the locality proof for global script files', () => {
    // pkgc alone: the script helper is the first demand, so a wrongly passing
    // proof would index helper.ts only and lose the caller.ts call site.
    expect(dispatchersOf(['pkgc'], 'pkgc/script-event')).toEqual(['pkgc'])
  })
})

describe('memoized filesystem probes', () => {
  function countingSystem(): { system: ts.System; calls: string[] } {
    const calls: string[] = []
    const system: ts.System = {
      ...ts.sys,
      fileExists: (path) => { calls.push(`file ${path}`); return path === 'present' },
      directoryExists: (path) => { calls.push(`directory ${path}`); return true },
      realpath: (path) => { calls.push(`realpath ${path}`); return `/real/${path}` },
      readDirectory: (path, extensions) => { calls.push(`read ${path} ${String(extensions)}`); return [`${path}/a.ts`] },
      getDirectories: (path) => { calls.push(`directories ${path}`); return [`${path}/child`] },
    }
    return { system, calls }
  }

  it('answers repeated probes from the first result and restores the system', () => {
    const { system, calls } = countingSystem()
    const original = { ...system }
    const results = withMemoizedFileSystemProbes(() => {
      const listed = system.readDirectory('dir', ['.ts'])
      listed.push('mutated')
      return [
        system.fileExists('present'), system.fileExists('present'), system.fileExists('absent'),
        system.directoryExists('dir'), system.directoryExists('dir'),
        system.realpath?.('link'), system.realpath?.('link'),
        system.readDirectory('dir', ['.ts']), system.readDirectory('dir', ['.tsx']),
        system.getDirectories('dir'), system.getDirectories('dir'),
      ]
    }, system)
    expect(results).toEqual([
      true, true, false, true, true, '/real/link', '/real/link',
      ['dir/a.ts'], ['dir/a.ts'], ['dir/child'], ['dir/child'],
    ])
    expect(calls).toEqual([
      'read dir .ts', 'file present', 'file absent', 'directory dir', 'realpath link', 'read dir .tsx', 'directories dir',
    ])
    expect({ ...system }).toEqual(original)
  })

  it('records no result for a throwing probe and restores the system when the run throws', () => {
    const { system } = countingSystem()
    const original = { ...system }
    let attempts = 0
    system.fileExists = () => {
      attempts++
      if (attempts === 1) throw new Error('transient')
      return true
    }
    const replaced = { ...system }
    expect(() => withMemoizedFileSystemProbes(() => {
      expect(() => system.fileExists('path')).toThrow('transient')
      expect(system.fileExists('path')).toBe(true)
      throw new Error('run failed')
    }, system)).toThrow('run failed')
    expect(attempts).toBe(2)
    expect({ ...system }).toEqual(replaced)
    expect(replaced).not.toEqual(original)
  })

  it('builds the same Program through the memoized system', () => {
    const memoized = withMemoizedFileSystemProbes(() => new TypeScriptProject(root))
    expect(memoized.sourceFiles().map(sourceFile => sourceFile.fileName))
      .toEqual(project.sourceFiles().map(sourceFile => sourceFile.fileName))
  })
})
