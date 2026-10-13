import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildGates, parseBuildArguments } from './build.ts'

const root = resolve(import.meta.dirname, '..')

const artifactGraph = {
  'native': [],
  'host-src': ['native'],
  'host-bundle': ['host-src'],
  'desktop-bundle': ['host-bundle'],
  'client-src': ['desktop-bundle'],
  'client-bundle': ['client-src'],
  'web': ['client-bundle'],
}

function graph(gates: ReturnType<typeof buildGates>): Record<string, string[] | undefined> {
  return Object.fromEntries(gates.map(gate => [gate.id, gate.needs]))
}

describe('repository build CLI', () => {
  // The sentinel makes parseArgs fail fast if the check ever stops running first.
  it('rejects a Node process without TypeScript type stripping before any build step', () => {
    const result = spawnSync(
      process.execPath,
      ['--no-experimental-strip-types', '--import', 'tsx/esm', resolve(root, 'scripts/build.ts'), '--spec-sentinel'],
      { cwd: root, encoding: 'utf8' },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('build: Node.js TypeScript type stripping is unavailable')
  })

  it('rejects the removed artifacts-only flag before any build step', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx/esm', resolve(root, 'scripts/build.ts'), '--artifacts-only'],
      { cwd: root, encoding: 'utf8' },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Unknown option '--artifacts-only'")
  })

  it('selects the complete build by default and one step set by scope', () => {
    expect(parseBuildArguments([])).toEqual({ scope: 'complete', profile: undefined })
    expect(parseBuildArguments(['--scope', 'artifacts', '--profile', 'official'])).toEqual({ scope: 'artifacts', profile: 'official' })
    expect(parseBuildArguments(['--scope', 'check'])).toEqual({ scope: 'check', profile: undefined })
    expect(parseBuildArguments(['--scope', 'typecheck'])).toEqual({ scope: 'typecheck', profile: undefined })
  })

  it.each([
    [['--scope', 'complete'], '--scope must be artifacts, check, or typecheck'],
    [['--scope', 'lib'], '--scope must be artifacts, check, or typecheck'],
    [['--scope', 'check', '--profile', 'official'], '--profile selects artifact values and does not apply to --scope check'],
    [['--scope', 'typecheck', '--profile', 'official'], '--profile selects artifact values and does not apply to --scope typecheck'],
  ])('rejects %j', (args, message) => {
    expect(() => parseBuildArguments(args)).toThrow(message)
  })
})

describe('repository build steps', () => {
  it('keeps artifact steps in serial dependency order', () => {
    expect(graph(buildGates(root, 'artifacts'))).toEqual(artifactGraph)
  })

  it('checks both aggregate programs without artifact predecessors', () => {
    const gates = buildGates(root, 'check')
    expect(graph(gates)).toEqual({ 'host-check': [], 'client-check': [] })
    expect(gates.map(gate => gate.args.slice(-2))).toEqual([
      ['-p', 'tsconfig.host.json'],
      ['-p', 'tsconfig.client.json'],
    ])
  })

  it('starts each aggregate check after its own package compilation in the complete build', () => {
    expect(graph(buildGates(root, 'complete'))).toEqual({
      ...artifactGraph,
      'host-check': ['host-src'],
      'client-check': ['client-src'],
    })
  })

  it('type-checks every program with the source-only Typert pass beside Host compilation', () => {
    const gates = buildGates(root, 'typecheck')
    expect(graph(gates)).toEqual({
      'host-src': [],
      'host-typert': [],
      'client-src': ['host-src', 'host-typert'],
      'host-check': ['host-src'],
      'client-check': ['client-src'],
    })
    expect(gates.find(gate => gate.id === 'host-typert')?.args.at(-1)).toBe(resolve(root, 'scripts/generate-typert.ts'))
    expect(gates.filter(gate => gate.id.endsWith('-check')).map(gate => gate.args.slice(-2))).toEqual([
      ['-b', 'tsconfig.host.json'],
      ['-b', 'tsconfig.client.json'],
    ])
  })

  it('applies the environment overlay to every step', () => {
    const environment = { DSH_CLIENT_TITLE: 'Title', DSH_BUILD_CLIENT_PROFILE: undefined }
    for (const gate of buildGates(root, 'complete', environment)) expect(gate.env).toEqual(environment)
  })
})
