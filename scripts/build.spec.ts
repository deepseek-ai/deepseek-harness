import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildGates, parseBuildArguments } from './build.ts'

const root = resolve(import.meta.dirname, '..')

const artifactGraph = {
  'native': [],
  'host-typert': [],
  'host-src': ['native', 'host-typert'],
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
    expect(parseBuildArguments([])).toEqual({ scope: 'complete', profile: undefined, serial: false })
    expect(parseBuildArguments(['--scope', 'artifacts', '--profile', 'official'])).toEqual({ scope: 'artifacts', profile: 'official', serial: false })
    expect(parseBuildArguments(['--scope', 'check'])).toEqual({ scope: 'check', profile: undefined, serial: false })
    expect(parseBuildArguments(['--scope', 'typecheck'])).toEqual({ scope: 'typecheck', profile: undefined, serial: false })
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
  it('parses the explicit serial build option', () => {
    expect(parseBuildArguments(['--profile', 'official', '--serial'])).toEqual({ scope: 'complete', profile: 'official', serial: true })
  })

  it.each(['complete', 'artifacts', 'check', 'typecheck'] as const)('chains every %s step when serial execution is selected', (scope) => {
    const original = buildGates(root, scope)
    const serial = buildGates(root, scope, {}, true)
    expect(serial.map(gate => gate.id)).toEqual(original.map(gate => gate.id))
    for (const [index, gate] of serial.entries()) {
      const previous = serial[index - 1]
      if (previous !== undefined) expect(gate.needs).toContain(previous.id)
      for (const dependency of original[index]!.needs ?? []) expect(gate.needs).toContain(dependency)
    }
  })

  it.each(['complete', 'check', 'typecheck'] as const)('gives Host compilers and both aggregate checks an 8 GiB heap in %s scope', (scope) => {
    const gates = buildGates(root, scope)
    for (const gate of gates.filter(gate => gate.id === 'host-src' || gate.id === 'host-check' || gate.id === 'client-check')) {
      expect(gate.args[0]).toBe('--max-old-space-size=8192')
    }
    for (const gate of gates.filter(gate => gate.id === 'client-src')) {
      expect(gate.args.some(arg => arg.startsWith('--max-old-space-size'))).toBe(false)
    }
  })

  it('finishes Host and Desktop readers before Client compilation rewrites shared outputs', () => {
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

  it('type-checks every program after source-only Typert generation', () => {
    const gates = buildGates(root, 'typecheck')
    expect(graph(gates)).toEqual({
      'host-typert': [],
      'host-src': ['host-typert'],
      'client-src': ['host-src'],
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
