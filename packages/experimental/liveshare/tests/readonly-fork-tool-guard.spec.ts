/**
 * The guard a child's tool runtime registers: reason string out, and default-deny on anything the
 * guard cannot establish — including an empty or unparsed path set.
 *
 * This is a helper-level spec: the guard is not yet registered on a child context, and path
 * authorization here is a stub, so it proves the guard's own decisions and nothing about a live child.
 */

import { describe, expect, it } from 'vitest'
import {
  forkToolGuard,
  installChildEnforcement,
  type ForkToolExecution,
} from '../src/host/fork-tool-guard.ts'
import { READ_ONLY_FORK_CEILING, WRITE_FORK_CEILING } from '../src/host/fork-policy.ts'

const child = 'child-1'

/** A host whose authorization knows one workspace root and answers like a resolved path would. */
function ports(options: { readonly installed?: boolean; readonly shadowed?: readonly string[] } = {}) {
  const refused: string[] = []
  return {
    refused,
    ports: {
      childOf: (execution: ForkToolExecution) =>
        (execution.agent as { readonly child?: string } | undefined)?.child,
      enforcementInstalled: () => options.installed !== false,
      // Names the child's own scope registered shadow the deployment's definition, so the guard is told
      // which names resolved to the deployment's own tool and which did not.
      toolIsTrusted: (_childSessionId: string, tool: string) => !(options.shadowed ?? []).includes(tool),
      authorizeReadPath: (_childSessionId: string, path: string) => {
        refused.push(path)
        // Stands in for the host's own resolution: only paths under the granted root are inside it.
        return path === '/granted/a.ts' || path === '/granted/dir/b.ts'
      },
    },
  }
}

const execution = (name: string, args: unknown = {}): ForkToolExecution => ({
  name,
  arguments: args,
  agent: { child },
})

/** The tool-description half of the host's side, kept beside the specs that read it. */
const describeTool = (exec: ForkToolExecution) => {
  if (exec.name === 'todo_write') return { paths: [] as const, noFileEffect: true }
  const path = typeof exec.arguments === 'object' && exec.arguments !== null && 'path' in exec.arguments
    ? (exec.arguments as { readonly path: string }).path
    : undefined
  // Missing arguments establish neither a named target nor the absence of a filesystem effect.
  if (path === undefined) {
    return exec.name === 'read'
      ? { paths: undefined, noFileEffect: false }
      : { paths: [] as const, noFileEffect: false }
  }
  return { paths: [path], noFileEffect: false }
}

describe('fork tool guard', () => {
  it('allows a read whose paths are inside the granted workspace', () => {
    const { ports: host } = ports()
    const guard = forkToolGuard(host, () => READ_ONLY_FORK_CEILING, describeTool)

    expect(guard(execution('read', { path: '/granted/a.ts' }))).toBeUndefined()
    expect(guard(execution('read', { path: '/granted/dir/b.ts' }))).toBeUndefined()
    // Search tools are admitted once their declared path is inside the grant.
    expect(guard(execution('grep', { path: '/granted/a.ts' }))).toBeUndefined()
    expect(guard(execution('glob', { path: '/granted/a.ts' }))).toBeUndefined()
    // A tool declaring no filesystem effect needs no path at all.
    expect(guard(execution('todo_write'))).toBeUndefined()
  })

  it('installs nothing when this host cannot reach the child’s own context', () => {
    let registered = 0
    const host = {
      contextOf: () => undefined,
      registerGuard: () => { registered += 1; return () => {} },
      registerVerdictSource: () => () => {},
      recordEnforcement: () => true,
      releaseEnforcement: () => {},
    }

    const dispose = installChildEnforcement(
      {
        childSessionId: 'child-1',
        ceiling: READ_ONLY_FORK_CEILING,
        guard: () => undefined,
        verdictSource: async () => {},
      },
      host,
    )

    // No context means no guard to attach and no enforcement record to claim.
    expect(dispose).toBeUndefined()
    expect(registered).toBe(0)
  })

  it('records a child as enforced, and keeps a refusing guard in place after release', () => {
    const events: string[] = []
    let registered = 0
    const host = {
      contextOf: (id: string) => (id === 'child-1' ? { id } : undefined),
      registerGuard: () => { registered += 1; return () => { events.push('guard-disposed') } },
      registerVerdictSource: () => () => { events.push('verdicts-disposed') },
      recordEnforcement: (id: string) => { events.push(`recorded:${id}`); return true },
      releaseEnforcement: (id: string) => { events.push(`released:${id}`) },
    }

    const dispose = installChildEnforcement(
      {
        childSessionId: 'child-1',
        ceiling: READ_ONLY_FORK_CEILING,
        guard: () => undefined,
        verdictSource: async () => {},
      },
      host,
    )
    expect(registered).toBe(1)
    expect(events).toEqual(['recorded:child-1'])
    dispose?.()
    // Releasing drops the record and the verdict producer. The guard is NOT disposed: an unregistered
    // guard stops refusing, so a released child would run unguarded instead.
    expect(events).toEqual(['recorded:child-1', 'verdicts-disposed', 'released:child-1'])
  })

  it('replaces the same context’s released guard and keeps calls denied during teardown', async () => {
    const context = {}
    const guards: ((exec: ForkToolExecution) => string | undefined)[] = []
    let source: ((exec: ForkToolExecution) => Promise<void>) | undefined
    let installed = false
    const duringTeardown: (string | undefined)[] = []
    const call = execution('read', { path: '/granted/a.ts' })
    const host = {
      contextOf: () => context,
      registerGuard: (_context: object, guard: (exec: ForkToolExecution) => string | undefined) => {
        guards.push(guard)
        return () => { guards.splice(guards.indexOf(guard), 1) }
      },
      registerVerdictSource: (_context: object, next: (exec: ForkToolExecution) => Promise<void>) => {
        source = next
        return () => {
          duringTeardown.push(guards[0]?.(call))
          if (source === next) source = undefined
        }
      },
      recordEnforcement: () => { installed = true; return true },
      releaseEnforcement: () => { installed = false },
    }
    const install = () => {
      const verdicts = new Set<ForkToolExecution>()
      const dispose = installChildEnforcement({
        childSessionId: child,
        ceiling: READ_ONLY_FORK_CEILING,
        guard: exec => installed && verdicts.has(exec) ? undefined : 'missing verdict',
        verdictSource: async (exec) => { verdicts.add(exec) },
      }, host)
      return () => { verdicts.clear(); dispose?.() }
    }
    const first = install()
    await source?.(call)
    expect(guards[0]?.(call)).toBeUndefined()
    first()
    expect(guards[0]?.(call)).toBeTypeOf('string')
    const second = install()
    try {
      await source?.(call)
      expect(guards[0]?.(call)).toBeUndefined()
      expect(guards).toHaveLength(1)
      first()
      expect(installed).toBe(true)
    } finally {
      second()
    }
    expect(installed).toBe(false)
    expect(guards[0]?.(call)).toBeTypeOf('string')
    expect(duringTeardown.every(reason => typeof reason === 'string')).toBe(true)
  })

  it('keeps a persistent refusal when reinstallation fails and does not share an inherited owner', () => {
    const parent = {}
    const nested = Object.create(parent) as object
    const guards = new Map<object, ((exec: ForkToolExecution) => string | undefined)[]>()
    let available = true
    const registrationChecks: (string | undefined)[] = []
    const call = execution('read')
    const install = (context: object, reason: string) => installChildEnforcement({
      childSessionId: child,
      ceiling: READ_ONLY_FORK_CEILING,
      guard: () => reason,
      verdictSource: async () => {},
    }, {
      contextOf: () => context,
      registerGuard: (owner, guard) => {
        guards.set(owner, [...guards.get(owner) ?? [], guard])
        return () => {}
      },
      registerVerdictSource: (owner) => {
        registrationChecks.push(guards.get(owner)?.[0]?.(call))
        return available ? () => {} : undefined
      },
      recordEnforcement: () => true,
      releaseEnforcement: () => {},
    })
    const first = install(parent, 'parent')
    const childDispose = install(nested, 'nested')
    const second = install(parent, 'replacement')
    expect(guards.get(parent)).toHaveLength(1)
    expect(guards.get(nested)).toHaveLength(1)
    expect(guards.get(parent)?.[0]?.(call)).toBe('replacement')
    expect(guards.get(nested)?.[0]?.(call)).toBe('nested')
    first?.()
    expect(guards.get(parent)?.[0]?.(call)).toBe('replacement')
    available = false
    expect(install(parent, 'failed')).toBeUndefined()
    expect(guards.get(parent)?.[0]?.(call)).toMatch(/limits are not installed/u)
    expect(registrationChecks.slice(2).every(reason => typeof reason === 'string')).toBe(true)
    second?.()
    childDispose?.()
  })

  it('rolls back instead of half-installing when the runtime or the record refuses', () => {
    const events: string[] = []
    const noRuntime = {
      contextOf: () => ({ id: 'child-1' }),
      registerGuard: () => undefined,
      registerVerdictSource: () => () => { events.push('verdicts-disposed') },
      recordEnforcement: () => { events.push('recorded'); return true },
      releaseEnforcement: () => { events.push('released') },
    }
    // Nothing registered the guard, so nothing is recorded: a guard that does not exist is not a limit.
    expect(installChildEnforcement(
      {
        childSessionId: 'child-1',
        ceiling: READ_ONLY_FORK_CEILING,
        guard: () => undefined,
        verdictSource: async () => {},
      },
      noRuntime,
    )).toBeUndefined()
    // The verdict source is rolled back with the guard: a producer with no guard enforces nothing.
    expect(events).toEqual(['verdicts-disposed'])

    const unknownChild = {
      contextOf: () => ({ id: 'child-1' }),
      registerGuard: () => () => { events.push('guard-disposed') },
      registerVerdictSource: () => () => { events.push('verdicts-disposed') },
      recordEnforcement: () => false,
      releaseEnforcement: () => { events.push('released') },
    }
    // A child this host never recorded cannot be marked enforced. The guard stays registered so the
    // child refuses, and no record is written for it.
    expect(installChildEnforcement(
      {
        childSessionId: 'child-1',
        ceiling: READ_ONLY_FORK_CEILING,
        guard: () => undefined,
        verdictSource: async () => {},
      },
      unknownChild,
    )).toBeUndefined()
    // Neither half of the install survives, and the guard's own disposer was never called.
    expect(events).toEqual(['verdicts-disposed', 'verdicts-disposed'])
  })

  it('refuses a read outside the granted workspace and every acting capability', () => {
    const { ports: host, refused } = ports()
    const guard = forkToolGuard(host, () => READ_ONLY_FORK_CEILING, describeTool)

    // The path check runs through the host's resolution, not a prefix comparison in the guard.
    expect(guard(execution('read', { path: '/etc/passwd' }))).toMatch(/may only read inside the workspace/u)
    expect(refused).toContain('/etc/passwd')
    // Acting capabilities are refused before any path is even considered.
    for (const tool of ['bash', 'pwsh', 'cua', 'plugin_manager', 'schedule_create', 'write', 'edit', 'subagent']) {
      expect(guard(execution(tool, { path: '/granted/a.ts' }))).toMatch(/may not use/u)
    }
    // The write ceiling admits the two mutation tools; every other acting capability stays refused.
    const writeGuard = forkToolGuard(host, () => WRITE_FORK_CEILING, describeTool)
    expect(writeGuard(execution('write', { path: '/granted/a.ts' }))).toBeUndefined()
    expect(writeGuard(execution('edit', { path: '/granted/a.ts' }))).toBeUndefined()
    expect(writeGuard(execution('bash', { path: '/granted/a.ts' }))).toMatch(/may not use/u)
  })

  it('refuses a permitted name whose definition is one the child registered for itself', () => {
    const granted = ports()
    const shadowed = ports({ shadowed: ['read'] })

    expect(forkToolGuard(granted.ports, () => READ_ONLY_FORK_CEILING, describeTool)(
      execution('read', { path: '/granted/a.ts' }),
    )).toBeUndefined()
    // The same name and the same in-workspace path, but the definition about to run is the child's own:
    // a name-only ceiling would run it here.
    expect(forkToolGuard(shadowed.ports, () => READ_ONLY_FORK_CEILING, describeTool)(
      execution('read', { path: '/granted/a.ts' }),
    )).toMatch(/which this host did not install/u)
  })

  it('refuses while the child’s own limit is not installed, and unattributed calls always', () => {
    const { ports: host } = ports({ installed: false })
    const guard = forkToolGuard(host, () => READ_ONLY_FORK_CEILING, () => ({ paths: [], noFileEffect: true }))

    expect(guard(execution('read'))).toMatch(/limits are not installed/u)
    // A call this guard cannot attribute to a child is not one it can vouch for.
    expect(guard({ name: 'read', arguments: {} })).toMatch(/without a child session/u)
  })

  it('refuses an unparsed or empty path set instead of reading it as "no paths"', () => {
    const { ports: host } = ports()
    const guard = forkToolGuard(host, () => READ_ONLY_FORK_CEILING, describeTool)

    // Neither unparsed arguments nor an empty path set establish that a read has no filesystem effect.
    expect(guard(execution('read'))).toMatch(/paths could not be established/u)
    const emptyPaths = forkToolGuard(host, () => READ_ONLY_FORK_CEILING,
      () => ({ paths: [], noFileEffect: false }))
    expect(emptyPaths(execution('read'))).toMatch(/filesystem effect could not be established/u)
    // grep is on the surface, but a pathless call this fixture cannot place establishes no effect either.
    expect(guard(execution('grep'))).toMatch(/filesystem effect could not be established/u)
    // The no-filesystem escape hatch only ever applies to a tool the ceiling permits; the read-only
    // ceiling permits only read tools, so a tool outside it is refused before paths are considered.
    expect(guard(execution('clock'))).toMatch(/may not use/u)
  })
})
