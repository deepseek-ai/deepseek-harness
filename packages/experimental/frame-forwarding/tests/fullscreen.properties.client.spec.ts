// @vitest-environment jsdom
import { brandString } from '@deepseek-ai/dsh-brand'
import fc from 'fast-check'
import { expect, test } from 'vitest'
import type { FrameFullscreenState } from '../src/client/api.ts'
import { adaptFrameForwardingBridge } from '../src/client/wire.ts'
import type { FrameRxId } from '../src/types.ts'

const channels = ['A', 'B'] as const
type Channel = typeof channels[number]
const channel = fc.constantFrom(...channels)
const entry = fc.tuple(fc.constant('request'), channel, fc.integer({ min: 0, max: 2 }), fc.constantFrom('enter', 'refuse'))
const exit = fc.tuple(fc.constant('exit'), channel)
const reconnect = fc.tuple(fc.constant('reconnect'), channel)
const escape = fc.tuple(fc.constant('Escape'))
const channelAction = fc.oneof({ weight: 6, arbitrary: entry }, { weight: 2, arbitrary: exit }, reconnect, escape)
const pageAction = fc.oneof({ weight: 4, arbitrary: channelAction }, fc.tuple(fc.constantFrom('page enters', 'page leaves')))
const end = fc.tuple(fc.constantFrom('close all', 'fail', 'dispose'))
type Generated<T> = T extends fc.Arbitrary<infer A> ? A : never
type Action = Generated<typeof pageAction | typeof end>
const busy = 'Another native channel holds fullscreen.'

/** A private document per run. Only the scheduled continuation changes the top layer, before the DOM promise settles. */
function fullscreenDocument(scheduler: fc.Scheduler) {
  const doc = document.implementation.createHTMLDocument()
  const stack: Element[] = []
  const owner = new Map<Element, Channel>()
  let changed = (_previous: readonly Element[]): void => {}
  const mutate = (update: () => void) => {
    const previous = [...stack]
    update()
    doc.dispatchEvent(new Event('fullscreenchange'))
    changed(previous)
  }
  const show = (target: Element) => {
    mutate(() => {
      const old = stack.indexOf(target)
      if (old !== -1) stack.splice(old, 1)
      stack.push(target)
    })
  }
  const gate = (label: string) => scheduler.schedule(Promise.resolve(), label)
  let admitEntry = true, admitExit = true, entries = 0
  const make = (id: string) => {
    const target = doc.createElement('div')
    target.id = id
    doc.body.append(target)
    return target
  }
  const page = make('page')
  const elements = new Map(channels.map(rx => [rx, Array.from({ length: 3 }, (_, i) => {
    const target = make(`${rx}${i}`)
    owner.set(target, rx)
    target.requestFullscreen = () => {
      ++entries
      const accepted = admitEntry
      return gate(`DOM ${accepted ? 'enter' : 'refuse'} ${target.id}`).then(() => {
        if (!accepted) throw new TypeError('Entry refused')
        show(target)
      })
    }
    return target
  })]))
  Object.defineProperty(doc, 'fullscreenElement', { get: () => stack.at(-1) ?? null })
  doc.exitFullscreen = () => {
    const accepted = admitExit
    return gate(`DOM ${accepted ? 'exit' : 'refuse exit'} ${doc.fullscreenElement?.id}`).then(() => {
      if (!accepted || !stack.length) throw new TypeError('Exit refused')
      mutate(() => { stack.pop() })
    })
  }
  return {
    doc, stack, owner, elements, entryCount: () => entries,
    acceptEntry(value: boolean) { admitEntry = value },
    acceptExit(value: boolean) { admitExit = value },
    observe(listener: typeof changed) { changed = listener },
    escape() { if (stack.length) mutate(() => { stack.length = 0 }) },
    pageEnters() { show(page) },
    pageLeaves() { if (doc.fullscreenElement === page) mutate(() => { stack.pop() }) },
  }
}

const bridgeFor = (doc: Document) => adaptFrameForwardingBridge(
  { onFrame: () => () => {} }, { viewport: () => { throw Error('Unexpected viewport') } }, doc,
)
const id = (rx: Channel) => brandString<FrameRxId>(rx)

async function checkRun(scheduler: fc.Scheduler, bursts: Action[][], terminal: Generated<typeof end>) {
  const dom = fullscreenDocument(scheduler)
  const bridge = bridgeFor(dom.doc)
  // Only accepted requests in flight and the actual browser stack determine admission, never a bridge notification.
  const pending = new Map<Channel, number>(channels.map(rx => [rx, 0]))
  const latest = new Map<Channel, FrameFullscreenState>()
  const detach = new Map<Channel, () => Promise<void>>()
  const attempts = new Map<Channel, number>(channels.map(rx => [rx, 0]))
  const exitAt = new Map<Channel, number>()
  const coveredAtExit = new Set<Element>()
  const work: Promise<void>[] = []
  const issues: string[] = []
  const check = (ok: boolean, message: string) => { if (!ok) issues.push(message) }
  const observeTask = (task: Promise<void>, expected: string | undefined, label: string, done?: () => void) => {
    work.push(task.then(
      () => { check(expected === undefined, `${label}: expected ${expected}, resolved`) },
      (error: unknown) => {
        check(error instanceof Error && error.message === expected && (expected === busy || error instanceof TypeError),
          `${label}: expected ${expected ?? 'success'}, got ${String(error)}`)
      },
    ).then(done))
  }
  const attach = (rx: Channel) => {
    latest.set(rx, { active: false, holder: false })
    detach.set(rx, bridge.attach(id(rx), {
      onFrame() {},
      onEvent(event) { if (event.kind === 'fullscreen') latest.set(rx, event) },
    }))
  }
  const shownOwner = () => dom.owner.get(dom.stack.at(-1)!)
  const states = (previous?: readonly Element[]) => {
    check([...latest.values()].filter(s => s.active && s.holder).length <= 1, 'Two attached channels report holding fullscreen')
    for (const [rx, state] of latest) {
      const shown = dom.doc.fullscreenElement
      check(state.active === (shown !== null), `${rx}: active=${state.active}, shown=${shown?.id ?? 'none'}`)
      if (shown !== null) {
        if (rx !== shownOwner() || !coveredAtExit.has(shown)) {
          check(state.holder === (rx === shownOwner()), `${rx}: holder=${state.holder}, shown=${shown.id}`)
        }
      } else if (previous) {
        // A channel whose element was on top since fullscreen began may hear that it ended, also after leaving that
        // element; a channel with only a pending request held nothing that could end.
        if (dom.owner.get(previous.at(-1)!) === rx) check(state.holder, `${rx}: no end reported for its visible fullscreen`)
        if (!everTop.has(rx)) check(!state.holder, `${rx}: reported ending fullscreen it never entered`)
      }
    }
  }
  // The documented hold: a channel holds from its accepted request until fullscreen ends while none of its requests is
  // pending, or until its last request settles while none of its elements has been on top since fullscreen began. The
  // document reports only its top, so once a channel showed an element its hold lasts until fullscreen ends.
  let hold: Channel | undefined
  /** Channels with an element on top since the document entered fullscreen; only they may hear that it ended. */
  const everTop = new Set<Channel>()
  dom.observe((previous) => {
    const top = shownOwner()
    if (top !== undefined) everTop.add(top)
    states(previous)
    if (!dom.stack.length) {
      everTop.clear()
      if (hold !== undefined && pending.get(hold) === 0) hold = undefined
    }
  })
  for (const rx of channels) attach(rx)

  // The Fullscreen API can only pop the top. Do not require popping an unrelated page element to reach a buried one.
  const pageIndex = () => dom.stack.findLastIndex(el => !dom.owner.has(el))
  // An exit pops whatever is on top when it settles, so a page element entering while a channel's exit is in flight can
  // be popped in its place. The API offers no exit of one element; such an exit is not required to clear the channel.
  const exitsInFlight = new Map<Channel, number>(channels.map(rx => [rx, 0]))
  const racedExit = new Set<Channel>()
  const leave = (rx: Channel, closing: boolean) => {
    const version = attempts.get(rx)!
    exitAt.set(rx, version)
    for (const el of dom.stack.slice(pageIndex() + 1)) if (dom.owner.get(el) === rx) coveredAtExit.delete(el)
    exitsInFlight.set(rx, exitsInFlight.get(rx)! + 1)
    const call = closing ? detach.get(rx)!() : bridge.exitFullscreen(id(rx))
    if (closing) { latest.delete(rx); detach.delete(rx) }
    observeTask(call, undefined, `${closing ? 'detach' : 'exit'} ${rx}`, () => {
      exitsInFlight.set(rx, exitsInFlight.get(rx)! - 1)
      if (version === attempts.get(rx)) {
        for (const el of dom.stack.slice(0, pageIndex() + 1)) if (dom.owner.get(el) === rx) coveredAtExit.add(el)
      }
    })
  }
  let disposed = false
  const dispatch = (action: Action) => {
    switch (action[0]) {
      case 'request': {
        const [, rx, index, outcome] = action
        const blocked = hold !== undefined && hold !== rx
        const target = dom.elements.get(rx)![index]!
        const before = dom.entryCount()
        dom.acceptEntry(outcome === 'enter')
        if (!blocked) {
          hold = rx
          attempts.set(rx, attempts.get(rx)! + 1)
          pending.set(rx, pending.get(rx)! + 1)
          if (outcome === 'enter') coveredAtExit.delete(target)
        }
        const task = bridge.requestFullscreen(id(rx), target)
        const expected = blocked ? busy : outcome === 'refuse' ? 'Entry refused' : undefined
        observeTask(task, expected, `request ${target.id}`, () => {
          if (blocked) return
          pending.set(rx, pending.get(rx)! - 1)
          if (hold === rx && pending.get(rx) === 0 && !everTop.has(rx)) hold = undefined
        })
        check(dom.entryCount() === before + (blocked ? 0 : 1), `request ${target.id}: expected ${blocked ? 'bridge refusal' : 'DOM request'}`)
        break
      }
      case 'exit': leave(action[1], false); break
      case 'reconnect': leave(action[1], true); attach(action[1]); break
      case 'Escape': dom.escape(); break
      case 'page enters':
        for (const rx of channels) if (exitsInFlight.get(rx)! > 0) racedExit.add(rx)
        dom.pageEnters()
        break
      case 'page leaves': dom.pageLeaves(); break
      case 'close all': for (const rx of channels) leave(rx, true); break
      case 'fail': latest.clear(); bridge.fail('stream failed'); break
      case 'dispose': latest.clear(); disposed = true; bridge.dispose(); break
    }
    states()
  }
  // Preserve call order inside each burst, not completion order. The last call can tear down in-flight work.
  const rounds = bursts.map(burst => [...burst])
  if (!rounds.length) rounds.push([])
  rounds.at(-1)!.push(terminal)
  try {
    let raced = new Set<Channel>()
    for (const round of rounds) {
      const calls = scheduler.scheduleSequence(round.map(action => ({
        label: action.join(' '), builder: async () => { dispatch(action) },
      })))
      await scheduler.waitIdle()
      expect((await calls.task).faulty).toBe(false)
      await Promise.all(work.splice(0))
      states()
      for (const el of dom.stack.slice(pageIndex() + 1)) {
        const rx = dom.owner.get(el)!
        if (exitAt.get(rx) === attempts.get(rx) && !racedExit.has(rx)) check(coveredAtExit.has(el), `${rx}: exit left ${el.id} fullscreen`)
      }
      exitAt.clear()
      raced = new Set(racedExit)
      racedExit.clear()
      expect(issues).toEqual([])
    }
    // With no intervening page element this checks the entire Chromium stack, not just fullscreenElement === null.
    const reachable = dom.stack.slice(pageIndex() + 1).filter(el => !raced.has(dom.owner.get(el)!))
    expect(reachable.map(el => el.id), `orphaned after ${terminal[0]}`).toEqual([])
  } finally {
    if (!disposed) bridge.dispose()
    await scheduler.waitIdle()
    await Promise.all(work)
  }
}

// A shrink and its path replay must start at the same scheduler position. Rebuild it from immutable input for each run.
const scheduleSeed = fc.noShrink(fc.integer())
function scheduled<T extends unknown[]>(run: (scheduler: fc.Scheduler, ...args: T) => Promise<void>) {
  return async (seed: number, ...args: T) => {
    const scheduler = fc.sample(fc.scheduler(), { seed, numRuns: 1 })[0]!
    try { await run(scheduler, ...args) } catch (error) {
      const trace = scheduler.report().map(task => `${task.taskId}: ${task.label} (${task.status})`)
      throw new Error(trace.join('\n'), { cause: error })
    }
  }
}

// PowerShell replay: set $env:FC_SEED and $env:FC_PATH to the reported seed and path, then rerun the spec with
// -t '<failing test name>'. Set just FC_SEED to explore other schedules without changing the CI sample.
const options = {
  numRuns: 100, timeout: 3000, seed: Number(process.env.FC_SEED ?? 314159),
  ...(process.env.FC_PATH ? { path: process.env.FC_PATH } : {}),
}
for (const [name, actions] of [['channel elements', channelAction], ['channel and page elements', pageAction]] as const) {
  test(`fullscreen ownership across interleaved ${name}`, async () => {
    const burst = fc.array(actions as fc.Arbitrary<Action>, { minLength: 1, maxLength: 5 })
    await fc.assert(fc.asyncProperty(scheduleSeed, fc.array(burst, { maxLength: 7 }), end, scheduled(checkRun)), options)
  })
}

test('a refused exit retains the hold and concurrent retries preserve the page fullscreen underneath', async () => {
  const indices = fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 1, maxLength: 4 })
  const count = fc.integer({ min: 1, max: 3 })
  await fc.assert(fc.asyncProperty(scheduleSeed, channel, indices, count, scheduled(async (s, rx, moves, retries) => {
    const dom = fullscreenDocument(s)
    const bridge = bridgeFor(dom.doc)
    const other = channels.find(ch => ch !== rx)!
    try {
      for (const ch of channels) bridge.attach(id(ch), { onFrame() {}, onEvent() {} })
      dom.pageEnters()
      const page = dom.doc.fullscreenElement
      await s.waitFor(Promise.all(moves.map(i => bridge.requestFullscreen(id(rx), dom.elements.get(rx)![i]!))))
      const before = [...dom.stack]
      dom.acceptExit(false)
      await expect(s.waitFor(bridge.exitFullscreen(id(rx)))).rejects.toThrow('Exit refused')
      expect(dom.stack).toEqual(before)
      await expect(s.waitFor(bridge.requestFullscreen(id(other), dom.elements.get(other)![0]!))).rejects.toThrow(busy)
      dom.acceptExit(true)
      await s.waitFor(Promise.all(Array.from({ length: retries }, () => bridge.exitFullscreen(id(rx)))))
      expect(dom.stack.map(el => el.id)).toEqual([page!.id])
    } finally {
      dom.acceptExit(true)
      bridge.dispose()
      await s.waitIdle()
    }
  })), options)
})
