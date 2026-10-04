import { describe, expect, it, vi } from 'vitest'
import { BudgetClock, dispatch, ENGINE_ORIGIN, HookTimeoutError, RewriteRefusedError } from '../src/chain.ts'
import type { DispatchRequest, LoadedMod, RegisteredHook } from '../src/chain.ts'
import { createModsApi } from '../src/api.ts'
import type { AnyHook, HookMatcher, ModsApi } from '../src/types.ts'

const mod = (name: string, order = 0): LoadedMod => ({ name, version: undefined, root: '/mods/' + name, options: {}, order })

function hook(owner: LoadedMod, event: string, fn: AnyHook, matcher?: HookMatcher): RegisteredHook {
  return { mod: owner, event, matcher, hook: fn, catchHandler: undefined, reported: new Set() }
}

const fakeApi = {} as ModsApi

function request<E, R>(overrides: Partial<DispatchRequest<E, R>> & Pick<DispatchRequest<E, R>, 'input' | 'core' | 'hooks'>): DispatchRequest<E, R> {
  return {
    event: 'tool.call',
    origin: ENGINE_ORIGIN,
    api: () => fakeApi,
    budgetMs: 200,
    catchBudgetMs: 100,
    signal: new AbortController().signal,
    report: () => {},
    ...overrides,
  }
}

describe('dispatch: the three moves', () => {
  it('observes: a hook that returns next(e) sees the result from beneath and the core sees the original input', async () => {
    const seen: string[] = []
    const a = mod('a')
    const hooks = [
      hook(a, 'tool.call', async (_$, e, next) => {
        seen.push('before')
        const result = await next(e)
        seen.push('after')
        return result
      }),
    ]
    const result = await dispatch(request({ input: { tool: 'Bash' }, core: e => ({ result: 'ran ' + e.tool }), hooks }))
    expect(result).toEqual({ result: 'ran Bash' })
    expect(seen).toEqual(['before', 'after'])
  })

  it('rewrites: next receives the copy and later hooks and the core see it; the hook input is frozen', async () => {
    const a = mod('a')
    const b = mod('b', 1)
    let frozen = false
    const hooks = [
      hook(a, 'prompt.submit', (_$, e, next) => {
        frozen = Object.isFrozen(e) && Object.isFrozen((e as { nested: object }).nested)
        return next({ ...(e as object), text: 'trimmed' })
      }),
      hook(b, 'prompt.submit', (_$, e, next) => next({ ...(e as object), seenBy: 'b' })),
    ]
    const result = await dispatch(request({
      event: 'prompt.submit',
      input: { text: '  raw  ', nested: { deep: true } },
      core: e => e,
      hooks,
    }))
    expect(result).toMatchObject({ text: 'trimmed', seenBy: 'b' })
    expect(frozen).toBe(true)
  })

  it('answers: a hook that returns without calling next short-circuits later hooks and the core', async () => {
    const a = mod('a')
    const b = mod('b', 1)
    const later = vi.fn(async (_$: ModsApi, e: unknown, next: (e: unknown) => Promise<unknown>) => next(e))
    const core = vi.fn(() => ({ result: 'ran' }))
    const result = await dispatch(request({
      input: { tool: 'Bash' },
      core,
      hooks: [hook(a, 'tool.call', () => ({ deny: 'no' })), hook(b, 'tool.call', later)],
    }))
    expect(result).toEqual({ deny: 'no' })
    expect(later).not.toHaveBeenCalled()
    expect(core).not.toHaveBeenCalled()
  })

  it('runs hooks outermost first and the core last, with matchers evaluated against the input each hook receives', async () => {
    const order: string[] = []
    const a = mod('a')
    const b = mod('b', 1)
    const c = mod('c', 2)
    const hooks = [
      hook(a, 'tool.call', async (_$, e, next) => {
        order.push('a')
        return next({ ...(e as object), tool: 'Edit' })
      }),
      hook(b, 'tool.call', async (_$, e, next) => {
        order.push('b')
        return next(e)
      }, { tool: 'Bash' }),
      hook(c, 'tool.call', async (_$, e, next) => {
        order.push('c')
        return next(e)
      }, { tool: ['Edit', 'Write'] }),
    ]
    await dispatch(request({ input: { tool: 'Bash' }, core: () => { order.push('core'); return {} }, hooks }))
    expect(order).toEqual(['a', 'c', 'core'])
  })

  it('reaches the core directly when no hook is registered, and passes a primitive input through unfrozen', async () => {
    await expect(dispatch(request({ input: 1, core: e => e + 1, hooks: [] }))).resolves.toBe(2)
    const a = mod('a')
    await expect(dispatch(request({ input: 'text', core: e => ({ got: e }), hooks: [hook(a, 'tool.call', (_$, e, next) => next(e))] })))
      .resolves.toEqual({ got: 'text' })
  })

  it('exposes origin, budget, and signal on next; next.to rejects', async () => {
    const a = mod('a')
    const controller = new AbortController()
    let observed: Record<string, unknown> = {}
    await dispatch(request({
      input: {},
      core: () => ({}),
      signal: controller.signal,
      hooks: [hook(a, 'tool.call', async (_$, e, next) => {
        observed = { origin: next.origin, ms: next.budget.ms, remaining: next.budget.remainingMs, aborted: next.signal.aborted }
        await expect(next.to(e, 'append')).rejects.toThrow(/next\.to is only available/)
        return next(e)
      })],
    }))
    expect(observed.origin).toEqual(ENGINE_ORIGIN)
    expect(observed.ms).toBe(200)
    expect(observed.remaining).toBeLessThanOrEqual(200)
    expect(observed.aborted).toBe(false)
  })
})

describe('dispatch: one run beneath per hook', () => {
  it('hands a second next call the first run and awaits a started run before the hook\'s own answer settles', async () => {
    const a = mod('a')
    const core = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      return { ok: 'core' }
    })
    const twice = hook(a, 'tool.call', async (_$, e, next) => {
      const [first, second] = await Promise.all([next(e), next(e)])
      return { ok: 'hook', same: first === second }
    })
    expect(await dispatch(request({ input: {}, core, hooks: [twice] }))).toEqual({ ok: 'hook', same: true })
    expect(core).toHaveBeenCalledTimes(1)

    const settled: string[] = []
    const draining = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      settled.push('core')
      return { ok: 'core' }
    })
    // The hook answers at once while the run beneath is still going; the dispatch settles after that run.
    const eager = hook(a, 'tool.call', (_$, e, next) => {
      void next(e)
      return { deny: 'answered first' }
    })
    expect(await dispatch(request({ input: {}, core: draining, hooks: [eager] }))).toEqual({ deny: 'answered first' })
    expect(settled).toEqual(['core'])
  })

  it('reports a run beneath that fails after the hook answered, and attributes a refused rewrite to the hook', async () => {
    const a = mod('a')
    const report = vi.fn()
    const eager = hook(a, 'tool.call', (_$, e, next) => {
      next(e).catch(() => {})
      return { deny: 'answered first' }
    })
    const failing = async (): Promise<{ ok: string }> => {
      await Promise.resolve()
      throw new Error('core broke')
    }
    expect(await dispatch(request({ input: {}, core: failing, hooks: [eager], report }))).toEqual({ deny: 'answered first' })
    expect(report).toHaveBeenCalledWith('a: tool.call: the chain beneath failed after the hook answered: core broke')

    // `validateNext` throws for a rewritten input: the hook is skipped and the original input runs beneath.
    const rewriting = hook(a, 'tool.call', (_$, e, next) => next({ ...(e as object), command: 'changed' }))
    const core = vi.fn((e: unknown) => ({ ok: JSON.stringify(e) }))
    const result = await dispatch(request<{ command: string }, { ok: string }>({
      input: { command: 'original' },
      core,
      hooks: [rewriting],
      report,
      validateNext: (e) => {
        if (e.command !== 'original') throw new RewriteRefusedError('rewrote the arguments of echo; rewrites are not served')
      },
    }))
    expect(result).toEqual({ ok: '{"command":"original"}' })
    expect(report).toHaveBeenCalledWith('a: tool.call hook skipped: rewrote the arguments of echo; rewrites are not served')
    expect(core).toHaveBeenCalledTimes(1)

    // A validator that throws a bare value is reported through its text.
    const bare = await dispatch(request<{ command: string }, { ok: string }>({
      input: { command: 'original' },
      core,
      hooks: [hook(a, 'tool.call', (_$, e, next) => next({ ...(e as object), command: 'other' }))],
      report,
      validateNext: () => { throw 'refused as text' },
    }))
    expect(bare).toEqual({ ok: '{"command":"original"}' })
    expect(report).toHaveBeenCalledWith('a: tool.call hook skipped: threw Error: refused as text')
  })
})

describe('dispatch: failures', () => {
  it('skips a hook that throws before next and reports it once per kind; the next hook runs in its place', async () => {
    const a = mod('a')
    const b = mod('b', 1)
    const report = vi.fn()
    const failing = hook(a, 'tool.call', () => { throw new Error('boom') })
    const hooks = [failing, hook(b, 'tool.call', async (_$, e, next) => ({ ...(await next(e)) as object, b: true }))]
    const first = await dispatch(request({ input: {}, core: () => ({ result: 'ran' }), hooks, report }))
    const second = await dispatch(request({ input: {}, core: () => ({ result: 'ran' }), hooks, report }))
    expect(first).toEqual({ result: 'ran', b: true })
    expect(second).toEqual({ result: 'ran', b: true })
    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith('a: tool.call hook skipped: threw Error: boom')
  })

  it('keeps the result from beneath when the hook fails after next resolved, and runs nothing a second time', async () => {
    const a = mod('a')
    const core = vi.fn(() => ({ result: 'ran' }))
    const report = vi.fn()
    const result = await dispatch(request({
      input: {},
      core,
      report,
      hooks: [hook(a, 'tool.call', async (_$, e, next) => {
        await next(e)
        throw 'late'
      })],
    }))
    expect(result).toEqual({ result: 'ran' })
    expect(core).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith('a: tool.call hook skipped: threw late')
  })

  it('treats a hook that resolves to no result as skipped', async () => {
    const a = mod('a')
    const report = vi.fn()
    const result = await dispatch(request({ input: {}, core: () => ({ ok: true }), report, hooks: [hook(a, 'tool.call', () => undefined)] }))
    expect(result).toEqual({ ok: true })
    expect(report).toHaveBeenCalledWith('a: tool.call hook skipped: returned no result')
  })

  it('propagates an error thrown by the core without blaming the hook that awaited it', async () => {
    const a = mod('a')
    const report = vi.fn()
    await expect(dispatch(request({
      input: {},
      core: () => { throw new Error('engine down') },
      report,
      hooks: [hook(a, 'tool.call', (_$, e, next) => next(e))],
    }))).rejects.toThrow('engine down')
    expect(report).not.toHaveBeenCalled()
  })

  it('skips a hook whose own time runs past the budget; a late next from it is ignored', async () => {
    const a = mod('a')
    const report = vi.fn()
    const core = vi.fn(() => ({ result: 'ran' }))
    let lateNext: Promise<unknown> | undefined
    const result = await dispatch(request({
      input: {},
      core,
      report,
      budgetMs: 20,
      hooks: [hook(a, 'tool.call', async (_$, e, next) => {
        await new Promise(resolve => setTimeout(resolve, 60))
        lateNext = next(e)
        return { deny: 'too late' }
      })],
    }))
    expect(result).toEqual({ result: 'ran' })
    expect(report).toHaveBeenCalledWith('a: tool.call hook skipped: timeout, ran past its 20 ms limit')
    await new Promise(resolve => setTimeout(resolve, 60))
    await expect(lateNext).resolves.toBeUndefined()
    expect(core).toHaveBeenCalledTimes(1)
  })

  it('does not count time spent inside next or a mods API call against the budget', async () => {
    const a = mod('a')
    const report = vi.fn()
    const result = await dispatch(request({
      input: {},
      core: () => new Promise((resolve) => { setTimeout(() => { resolve({ result: 'slow core' }) }, 150) }),
      report,
      // Generous against a loaded CI host: only the hook's own microseconds between awaits may count.
      budgetMs: 100,
      // A real `$` whose every call takes 60 ms to answer: the clock pauses for the call.
      api: (hooked, clock) => createModsApi({
        mod: hooked.mod,
        clock,
        invoke: () => new Promise((resolve) => { setTimeout(() => { resolve('contents') }, 150) }),
        timers: { after: () => ({ cancel() {} }), every: () => ({ cancel() {} }) },
        report: () => {},
      }),
      hooks: [hook(a, 'tool.call', async ($, e, next) => {
        expect(await $.fs.read('notes.md')).toBe('contents')
        return next(e)
      })],
    }))
    expect(result).toEqual({ result: 'slow core' })
    expect(report).not.toHaveBeenCalled()
  })
})

describe('dispatch: .catch handlers', () => {
  it('lets the handler answer in a failed hook\'s place with next.error and next.called set', async () => {
    const a = mod('a')
    const failing = hook(a, 'tool.call', () => { throw new Error('boom') })
    let caught: Record<string, unknown> = {}
    failing.catchHandler = (_$, _e, next) => {
      caught = { kind: next.error?.kind, message: next.error?.message, called: next.called }
      return { deny: 'failed closed' }
    }
    const result = await dispatch(request({ input: {}, core: () => ({ result: 'ran' }), hooks: [failing] }))
    expect(result).toEqual({ deny: 'failed closed' })
    expect(caught).toEqual({ kind: 'throw', message: 'Error: boom', called: false })
  })

  it('gives the handler the already-resolved result from beneath when the hook had called next', async () => {
    const a = mod('a')
    const core = vi.fn(() => ({ result: 'ran' }))
    const failing = hook(a, 'tool.call', async (_$, e, next) => {
      await next(e)
      throw new Error('after')
    })
    failing.catchHandler = async (_$, e, next) => {
      expect(next.called).toBe(true)
      return { ...(await next(e)) as object, patched: true }
    }
    const result = await dispatch(request({ input: {}, core, hooks: [failing] }))
    expect(result).toEqual({ result: 'ran', patched: true })
    expect(core).toHaveBeenCalledTimes(1)
  })

  it('lets the handler call next itself when the hook never did, and falls back to skipping when it returns nothing or fails', async () => {
    const a = mod('a')
    const report = vi.fn()
    const viaNext = hook(a, 'tool.call', () => { throw new Error('boom') })
    viaNext.catchHandler = (_$, e, next) => next(e)
    expect(await dispatch(request({ input: {}, core: () => ({ ok: 1 }), hooks: [viaNext], report }))).toEqual({ ok: 1 })

    // A handler's next makes the same rewrite check as the hook's: a rewrite is refused and the handler is skipped.
    const rewritingHandler = hook(a, 'tool.call', () => { throw new Error('boom') })
    rewritingHandler.catchHandler = (_$, e, next) => next({ ...(e as object), command: 'changed' })
    const core = vi.fn((e: unknown) => ({ ok: JSON.stringify(e) }))
    expect(await dispatch(request<{ command: string }, { ok: string }>({
      input: { command: 'original' },
      core,
      hooks: [rewritingHandler],
      report,
      validateNext: (e) => {
        if (e.command !== 'original') throw new RewriteRefusedError('rewrites are not served')
      },
    }))).toEqual({ ok: '{"command":"original"}' })
    expect(report).toHaveBeenCalledWith('a: tool.call .catch handler skipped: rewrites are not served')
    const bareHandler = hook(a, 'tool.call', () => { throw new Error('boom') })
    bareHandler.catchHandler = (_$, e, next) => next({ ...(e as object), command: 'other' })
    await dispatch(request<{ command: string }, { ok: string }>({
      input: { command: 'original' }, core, hooks: [bareHandler], report, validateNext: () => { throw 'refused as text' },
    }))
    expect(report).toHaveBeenCalledWith('a: tool.call .catch handler skipped: threw Error: refused as text')

    // A handler that ran beneath and then returned nothing: what it ran stands, nothing runs again.
    const ranBeneath = hook(a, 'tool.call', () => { throw new Error('boom') })
    ranBeneath.catchHandler = async (_$, e, next) => {
      await next(e)
      return undefined
    }
    const onceCore = vi.fn(() => ({ ok: 'once' }))
    expect(await dispatch(request({ input: {}, core: onceCore, hooks: [ranBeneath], report }))).toEqual({ ok: 'once' })
    expect(onceCore).toHaveBeenCalledTimes(1)

    const silent = hook(a, 'tool.call', () => { throw new Error('boom') })
    silent.catchHandler = () => undefined
    expect(await dispatch(request({ input: {}, core: () => ({ ok: 2 }), hooks: [silent], report }))).toEqual({ ok: 2 })

    const throwing = hook(a, 'tool.call', () => { throw new Error('boom') })
    throwing.catchHandler = () => { throw new Error('handler boom') }
    expect(await dispatch(request({ input: {}, core: () => ({ ok: 3 }), hooks: [throwing], report }))).toEqual({ ok: 3 })
    expect(report).toHaveBeenCalledWith('a: tool.call .catch handler skipped: threw Error: handler boom')

    const inspecting = hook(a, 'tool.call', () => { throw new Error('boom') })
    inspecting.catchHandler = async (_$, e, next) => {
      expect(next.budget.ms).toBe(100)
      expect(next.budget.remainingMs).toBeLessThanOrEqual(100)
      await expect(next.to(e, 'core')).rejects.toThrow(/not available in a \.catch handler/)
      return { deny: 'inspected' }
    }
    expect(await dispatch(request({ input: {}, core: () => ({ ok: 5 }), hooks: [inspecting], report }))).toEqual({ deny: 'inspected' })

    const slow = hook(a, 'tool.call', () => { throw new Error('boom') })
    let lateNext: Promise<unknown> | undefined
    slow.catchHandler = async (_$, e, next) => {
      await new Promise(resolve => setTimeout(resolve, 60))
      lateNext = next(e)
      return { deny: 'late' }
    }
    const slowCore = vi.fn(() => ({ ok: 4 }))
    expect(await dispatch(request({ input: {}, core: slowCore, hooks: [slow], report, catchBudgetMs: 15 }))).toEqual({ ok: 4 })
    expect(report).toHaveBeenCalledWith('a: tool.call .catch handler skipped: timeout, ran past its 15 ms limit')
    await new Promise(resolve => setTimeout(resolve, 60))
    await expect(lateNext).resolves.toBeUndefined()
    expect(slowCore).toHaveBeenCalledTimes(1)
  })
})

describe('BudgetClock', () => {
  it('counts only busy time, pauses while nested, and stops without firing once settled', async () => {
    let now = 0
    const clock = new BudgetClock(100, () => now)
    expect(clock.remainingMs).toBe(100)
    clock.start()
    now = 30
    expect(clock.remainingMs).toBe(70)
    clock.pause()
    clock.pause()
    now = 500
    expect(clock.remainingMs).toBe(70)
    clock.resume()
    expect(clock.remainingMs).toBe(70)
    clock.resume()
    now = 520
    expect(clock.remainingMs).toBe(50)
    clock.stop()
    clock.start()
    clock.pause()
    clock.resume()
    expect(clock.remainingMs).toBe(50)
    const pending = new Promise((resolve) => { setTimeout(() => { resolve('pending') }, 20) })
    const raced = await Promise.race([clock.expired.catch((error: unknown) => error), pending])
    expect(raced).toBe('pending')
  })

  it('rejects the deadline with HookTimeoutError once busy time reaches the limit', async () => {
    const clock = new BudgetClock(10)
    clock.start()
    await expect(clock.expired).rejects.toBeInstanceOf(HookTimeoutError)
    expect(clock.remainingMs).toBe(0)
  })

  it('resume without a matching pause is a no-op', () => {
    const clock = new BudgetClock(10)
    clock.resume()
    expect(clock.remainingMs).toBe(10)
    clock.stop()
  })
})
