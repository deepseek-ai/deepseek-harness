/**
 * @vitest-environment jsdom
 *
 * Closure evaluation account: the symbol surface a browser half receives, the
 * teaching traps shadowing ambient globals, the parse/return diagnostics, and
 * the style bookkeeping whose disposal the runner owns.
 */
import * as React from 'react'
import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it, vi } from 'vitest'
import type { CordisDynamicPluginId } from '@deepseek-ai/dsh-api-remotes/client'
import {
  DynamicCordisStyles,
  DYNAMIC_CLIENT_REDIRECTS,
  evaluateClientHalf,
  isDynamicCordisPlugin,
} from '../src/client/evaluator.ts'
import type { DynamicCordisClosureEnv, DynamicCordisEvaluatedPlugin } from '../src/client/evaluator.ts'

const ID = brandString<CordisDynamicPluginId>('dyn-1')

function env(overrides: Partial<DynamicCordisClosureEnv> = {}): DynamicCordisClosureEnv {
  return {
    invoke: () => Promise.resolve(null),
    noteError: () => {},
    ...overrides,
  }
}

/** Evaluate one source with fresh style bookkeeping. */
async function run(source: string, closure: DynamicCordisClosureEnv = env()): Promise<{
  plugin: DynamicCordisEvaluatedPlugin | ((ctx: unknown) => unknown)
  styles: DynamicCordisStyles
}> {
  const styles = new DynamicCordisStyles(ID)
  const plugin = await evaluateClientHalf(ID, source, closure, styles)
  return { plugin, styles }
}

describe('evaluateClientHalf', () => {
  it('returns the object-form plugin and hands the page React instance to the closure', async () => {
    const { plugin } = await run(`
      if (React.createElement === undefined) throw new Error('React symbol missing')
      return { name: 'ignored', inject: ['slots'], apply(ctx) { return React } }
    `)
    expect(typeof plugin).toBe('object')
    const object = plugin as DynamicCordisEvaluatedPlugin
    expect(object.inject).toEqual(['slots'])
    // Same instance as the page's React: a second copy would break hooks.
    expect(object.apply({})).toBe(React)
  })

  it('accepts the function form', async () => {
    const { plugin } = await run('return (ctx) => "applied"')
    expect(typeof plugin).toBe('function')
    expect((plugin as (ctx: unknown) => unknown)({})).toBe('applied')
  })

  it('redirects browser timers to the ctx facade', async () => {
    for (const timer of ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] as const) {
      const { plugin } = await run(`return () => ${timer}(() => {}, 1)`)
      expect(() => (plugin as (ctx: unknown) => unknown)({}))
        .toThrow(DYNAMIC_CLIENT_REDIRECTS[timer])
    }
  })

  it('redirects fetch to the host half and require to the closure symbols', async () => {
    const { plugin: fetcher } = await run('return () => fetch("/x")')
    expect(() => (fetcher as (ctx: unknown) => unknown)({})).toThrow(/network belongs to the HOST half/)
    const { plugin: importer } = await run('return () => require("react")')
    expect(() => (importer as (ctx: unknown) => unknown)({})).toThrow(/React arrives as the `React` closure symbol/)
  })

  it('teaches the half split on any harness access', async () => {
    const { plugin } = await run('return () => harness.handle("m", () => {})')
    expect(() => (plugin as (ctx: unknown) => unknown)({}))
      .toThrow(/harness\.handle belongs to the HOST half/)
  })

  it('routes host.call to the runner invoke seam', async () => {
    const invoke = vi.fn(() => Promise.resolve({ ok: 1 }))
    const { plugin } = await run('return { apply: (ctx) => host.call("ping", { a: 1 }) }', env({ invoke }))
    await expect((plugin as DynamicCordisEvaluatedPlugin).apply({})).resolves.toEqual({ ok: 1 })
    expect(invoke).toHaveBeenCalledWith('ping', { a: 1 })
  })

  it('sends null for a host.call written without arguments', async () => {
    const invoke = vi.fn(() => Promise.resolve(['fs', 'web']))
    // A handler that takes nothing is the natural case ("list the services"), and
    // `undefined` is not JSON — so the omission travels as null rather than
    // making the wire refuse the call.
    const { plugin } = await run('return { apply: (ctx) => host.call("listServices") }', env({ invoke }))
    await expect((plugin as DynamicCordisEvaluatedPlugin).apply({})).resolves.toEqual(['fs', 'web'])
    expect(invoke).toHaveBeenCalledWith('listServices', null)
  })

  it('reports a parse failure as a plain-JavaScript teaching error', async () => {
    await expect(run('return (')).rejects.toThrow(/client half failed to parse in this browser/)
    await expect(run('return (')).rejects.toThrow(/no JSX, no TypeScript/)
  })

  it('names the missing return, and rejects a non-plugin value', async () => {
    await expect(run('const x = 1')).rejects.toThrow(/did you forget `return`/)
    await expect(run('return 42')).rejects.toThrow(/must `return` a plugin/)
  })

  it('propagates a non-syntax construction failure untouched', async () => {
    const boom = new TypeError('engine refused')
    // The constructor is the only failure seam before evaluation; a
    // non-SyntaxError must not be reinterpreted as a source problem.
    vi.stubGlobal('Function', function stub(): never { throw boom })
    try {
      await expect(run('return () => {}')).rejects.toBe(boom)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(typeof Function).toBe('function')
  })
})

describe('tagged console', () => {
  it('mirrors only error lines, and stringifies every argument shape', async () => {
    const seen: string[] = []
    const closure = env({ noteError: message => seen.push(message) })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const { plugin } = await run(`
      return { apply: (ctx) => {
        console.log('quiet')
        console.warn('also quiet')
        console.error('text', new Error('boom'), { a: 1 }, undefined, ctx.circular)
        console.debug('quiet too')
      } }
    `, closure)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    ;(plugin as DynamicCordisEvaluatedPlugin).apply({ circular })
    vi.restoreAllMocks()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe('text boom {"a":1} undefined [unserializable console argument]')
  })

  it('truncates a long mirrored error', async () => {
    const seen: string[] = []
    const { plugin } = await run(
      'return { apply: () => console.error("x".repeat(900)) }',
      env({ noteError: message => seen.push(message) }),
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(plugin as DynamicCordisEvaluatedPlugin).apply({})
    vi.restoreAllMocks()
    expect(seen[0]).toHaveLength(500)
  })
})

describe('DynamicCordisStyles', () => {
  it('stamps ownership, counts live tags, and disposes one tag or all of them', () => {
    const styles = new DynamicCordisStyles(ID)
    const first = styles.insert('.a { color: red }')
    styles.insert('.b { color: blue }')
    expect(styles.count).toBe(2)
    const tags = [...document.querySelectorAll('style[data-dyn="dyn-1"]')]
    expect(tags).toHaveLength(2)
    expect(tags[0]?.textContent).toBe('.a { color: red }')
    first()
    expect(styles.count).toBe(1)
    expect(document.querySelectorAll('style[data-dyn="dyn-1"]')).toHaveLength(1)
    styles.dispose()
    expect(styles.count).toBe(0)
    expect(document.querySelectorAll('style[data-dyn="dyn-1"]')).toHaveLength(0)
  })

  it('rejects a non-string stylesheet', () => {
    const styles = new DynamicCordisStyles(ID)
    expect(() => styles.insert(42 as unknown as string)).toThrow(/needs a CSS string/)
  })

  it('exposes styles.insert to the closure', async () => {
    const { plugin, styles } = await run('return { apply: () => styles.insert(".c {}") }')
    ;(plugin as DynamicCordisEvaluatedPlugin).apply({})
    expect(styles.count).toBe(1)
    styles.dispose()
  })
})

describe('isDynamicCordisPlugin', () => {
  it('accepts both mountable forms and rejects everything else', () => {
    expect(isDynamicCordisPlugin(() => {})).toBe(true)
    expect(isDynamicCordisPlugin({ apply: () => {} })).toBe(true)
    expect(isDynamicCordisPlugin({})).toBe(false)
    expect(isDynamicCordisPlugin(null)).toBe(false)
    expect(isDynamicCordisPlugin(42)).toBe(false)
  })
})
