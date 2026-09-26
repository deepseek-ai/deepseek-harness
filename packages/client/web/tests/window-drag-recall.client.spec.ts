// @vitest-environment jsdom
/**
 * The shell's one window drag watcher, driven through its two scheduling seams:
 * the spec owns the frame queue and the per-row box watchers, so every pulse is
 * decided by the test rather than by wall-clock timing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DRAG_MARK, RECALL_MARK } from '../src/window-drag/regions.ts'
import { installWindowDragRecall } from '../src/window-drag/recall.ts'

/** A viewport box a row reports. */
type Box = readonly [x: number, y: number, width: number, height: number]

/** The frame queue and the box watchers the watcher under test was handed. */
interface Harness {
  readonly frames: () => number
  readonly runFrames: () => void
  readonly watched: () => Element[]
  readonly resize: (row: Element) => void
  readonly disposedWatchers: () => number
  readonly scheduleFrame: (frame: () => void) => () => void
  readonly watchBox: (row: Element, changed: () => void) => () => void
}

/** The seams and views one spec needs to drive the watcher. */
function harness(): Harness {
  const queue: (() => void)[] = []
  const watchers = new Map<Element, () => void>()
  const resizers = new Map<Element, () => void>()
  let disposed = 0
  return {
    frames: () => queue.length,
    runFrames: () => {
      const pending = queue.splice(0, queue.length)
      for (const frame of pending) frame()
    },
    watched: () => [...watchers.keys()],
    resize: (row) => {
      const changed = resizers.get(row)
      if (changed === undefined) throw new Error('the row is not watched')
      changed()
    },
    disposedWatchers: () => disposed,
    scheduleFrame: (frame) => {
      queue.push(frame)
      return () => {
        const index = queue.indexOf(frame)
        if (index !== -1) queue.splice(index, 1)
      }
    },
    watchBox: (row, changed) => {
      watchers.set(row, changed)
      resizers.set(row, changed)
      return () => {
        watchers.delete(row)
        resizers.delete(row)
        disposed += 1
      }
    },
  }
}

/** Place a row's reported box, so a measurement change is the spec's decision. */
function place(row: Element, box: Box): void {
  const [x, y, width, height] = box
  Object.defineProperty(row, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON: () => ({}),
    }),
  })
}

/** Append one marked row to the body. */
function row(box: Box = [0, 0, 100, 52]): HTMLDivElement {
  const element = document.createElement('div')
  element.setAttribute(DRAG_MARK, '')
  place(element, box)
  document.body.append(element)
  return element
}

/** Let a queued MutationObserver callback run. */
async function flushMutations(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

/**
 * Run frames until the watcher stops re-arming. Every report opens a short grace
 * window, so a settled surface needs more than one frame to fall idle.
 * @param seams - the frame queue under test.
 */
function settle(seams: Harness): void {
  for (let frame = 0; frame < 8 && seams.frames() > 0; frame += 1) seams.runFrames()
}

/** Whether the recall mark is currently set. */
function marked(): boolean {
  return document.body.hasAttribute(RECALL_MARK)
}

beforeEach(() => {
  document.documentElement.dataset.platform = 'darwin'
})

afterEach(() => {
  delete document.documentElement.dataset.platform
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('window drag watcher installation', () => {
  it('installs nothing outside the darwin platform', async () => {
    delete document.documentElement.dataset.platform
    const seams = harness()
    const stop = installWindowDragRecall({
      document, scheduleFrame: seams.scheduleFrame, watchBox: seams.watchBox,
    })
    const element = row()
    place(element, [0, 10, 100, 52])
    element.setAttribute('class', 'moved')
    await flushMutations()
    seams.runFrames()
    expect(marked()).toBe(false)
    expect(seams.watched()).toEqual([])
    stop()
  })

  it('collects the surface once when it is installed', () => {
    const seams = harness()
    const stop = installWindowDragRecall({
      document, scheduleFrame: seams.scheduleFrame, watchBox: seams.watchBox,
    })
    row()
    expect(seams.frames()).toBe(1)
    seams.runFrames()
    expect(marked()).toBe(true)
    expect(seams.frames()).toBe(1)
    seams.runFrames()
    // The steady-state collection: the mark is gone and the watcher is idle.
    expect(marked()).toBe(false)
    expect(seams.frames()).toBe(0)
    stop()
    expect(seams.disposedWatchers()).toBe(1)
  })

  it('keeps pulsing while a box moves and stops when the geometry settles', () => {
    const seams = harness()
    const element = row()
    const stop = installWindowDragRecall({
      document, scheduleFrame: seams.scheduleFrame, watchBox: seams.watchBox,
    })
    seams.runFrames()
    seams.runFrames()
    expect(marked()).toBe(false)

    // A box watcher reports a resize: the row keeps sliding for three frames.
    place(element, [0, 20, 100, 52])
    seams.resize(element)
    seams.runFrames()
    expect(marked()).toBe(true)
    place(element, [0, 30, 100, 52])
    seams.runFrames()
    expect(marked()).toBe(true)
    seams.runFrames()
    expect(marked()).toBe(false)
    expect(seams.frames()).toBe(0)
    stop()
  })

  it('keeps at most one frame pending across several reported changes', async () => {
    const seams = harness()
    const element = row()
    const stop = installWindowDragRecall({
      document, scheduleFrame: seams.scheduleFrame, watchBox: seams.watchBox,
    })
    seams.runFrames()
    seams.runFrames()
    element.setAttribute('class', 'one')
    await flushMutations()
    element.setAttribute('class', 'two')
    await flushMutations()
    expect(seams.frames()).toBe(1)
    stop()
  })

  it('pulses for a row that was removed, and drops its box watcher', async () => {
    const seams = harness()
    const element = row()
    const other = row([100, 0, 100, 52])
    const stop = installWindowDragRecall({
      document, scheduleFrame: seams.scheduleFrame, watchBox: seams.watchBox,
    })
    seams.runFrames()
    seams.runFrames()
    expect(seams.watched()).toEqual([element, other])

    element.remove()
    await flushMutations()
    expect(seams.frames()).toBe(1)
    seams.runFrames()
    expect(marked()).toBe(true)
    expect(seams.disposedWatchers()).toBe(1)
    expect(seams.watched()).toEqual([other])
    stop()
  })
})

describe('what re-arms the watcher', () => {
  /** Install over an empty body, run the collection frame, and report the seams. */
  function installed(): { seams: Harness; stop: () => void } {
    const seams = harness()
    const stop = installWindowDragRecall({
      document, scheduleFrame: seams.scheduleFrame, watchBox: seams.watchBox,
    })
    seams.runFrames()
    seams.runFrames()
    return { seams, stop }
  }

  it.each([
    ['an attribute on a marked row', (element: HTMLElement) => { element.setAttribute('class', 'elsewhere') }],
    ['an attribute inside a marked row', (element: HTMLElement) => {
      const child = document.createElement('span')
      element.append(child)
      child.setAttribute('class', 'chip')
    }],
    ['a text change inside a marked row', (element: HTMLElement) => { element.firstChild!.textContent = 'renamed' }],
    ['an attribute on an element holding a marked row', (element: HTMLElement) => {
      element.parentElement!.setAttribute('class', 'panel-open')
    }],
  ])('re-arms on %s', async (_name, change) => {
    const { seams, stop } = installed()
    const element = row()
    element.append(document.createTextNode('title'))
    seams.runFrames()
    seams.runFrames()
    change(element)
    await flushMutations()
    expect(seams.frames()).toBe(1)
    stop()
  })

  it.each([
    ['a node that contains a marked row', () => {
      const wrapper = document.createElement('div')
      wrapper.append(row())
      document.body.append(wrapper)
    }],
    ['a marked row itself', () => { document.body.append(row()) }],
  ])('re-arms on a child list change adding %s', async (_name, mutate) => {
    const { seams, stop } = installed()
    mutate()
    await flushMutations()
    expect(seams.frames()).toBe(1)
    stop()
  })

  it('re-arms on a plain sibling inserted in a container that holds a marked row', async () => {
    const { seams, stop } = installed()
    const element = row()
    await flushMutations()
    settle(seams)
    expect(seams.frames()).toBe(0)

    // The row is not the container's first child here, so a sibling inserted beside
    // it shifts it without resizing it: only this child-list report can see that.
    element.before(document.createElement('span'))
    await flushMutations()
    expect(seams.frames()).toBe(1)
    stop()
  })

  it('ignores a change that cannot move the surface: a change in a container without a marked row', async () => {
    const { seams, stop } = installed()
    row()
    await flushMutations()
    settle(seams)
    expect(seams.frames()).toBe(0)

    // The transcript appends beside the rows, never into the containers holding them.
    const transcript = document.createElement('div')
    document.body.append(transcript)
    await flushMutations()
    settle(seams)
    expect(seams.frames()).toBe(0)
    transcript.append(document.createElement('span'), document.createTextNode('streamed'))
    await flushMutations()
    expect(seams.frames()).toBe(0)
    expect(marked()).toBe(false)
    stop()
  })

  it('keeps measuring after a report whose box has not moved yet', async () => {
    const { seams, stop } = installed()
    const element = row()
    await flushMutations()
    settle(seams)
    expect(seams.watched()).toEqual([element])

    // A CSS transition reports its start before the box moves: the first sample still
    // equals the last frame's geometry, and the slide that follows has to keep pulsing.
    element.setAttribute('class', 'sliding')
    await flushMutations()
    seams.runFrames()
    expect(marked()).toBe(false)
    place(element, [0, 14, 100, 52])
    seams.runFrames()
    expect(marked()).toBe(true)
    stop()
  })

  it('re-arms only for a transition on a marked row, or on an element holding one', async () => {
    const { seams, stop } = installed()
    const holder = document.createElement('div')
    const plain = document.createElement('div')
    document.body.append(holder, plain)
    const element = document.createElement('div')
    element.setAttribute(DRAG_MARK, '')
    place(element, [0, 0, 100, 52])
    holder.append(element)
    await flushMutations()
    settle(seams)
    expect(seams.frames()).toBe(0)

    // A transition elsewhere on the page, and a target that is not an element, move no row.
    plain.dispatchEvent(new Event('transitionstart'))
    document.dispatchEvent(new Event('transitionstart'))
    expect(seams.frames()).toBe(0)
    holder.dispatchEvent(new Event('transitionstart'))
    expect(seams.frames()).toBe(1)
    settle(seams)
    element.dispatchEvent(new Event('animationstart'))
    expect(seams.frames()).toBe(1)
    stop()
  })

  it('leaves a marked row out of the watch set while it stays put', async () => {
    const { seams, stop } = installed()
    const element = row()
    await flushMutations()
    seams.runFrames()
    expect(seams.watched()).toEqual([element])
    element.setAttribute('class', 'same-row')
    await flushMutations()
    seams.runFrames()
    expect(seams.watched()).toEqual([element])
    expect(seams.disposedWatchers()).toBe(0)
    stop()
  })
})

describe('the shell defaults', () => {
  it('drives the pulse from the animation frame queue and observes boxes', async () => {
    const frames: FrameRequestCallback[] = []
    const cancelled: number[] = []
    const observed: Element[] = []
    const resizers: (() => void)[] = []
    let disconnected = 0
    vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => frames.push(frame))
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => { cancelled.push(handle) })
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resizers.push(callback) }
      observe(row: Element): void { observed.push(row) }
      disconnect(): void { disconnected += 1 }
    })

    const element = row()
    const stop = installWindowDragRecall({ document })
    expect(frames).toHaveLength(1)
    frames.splice(0, 1)[0]!(0)
    expect(observed).toEqual([element])
    expect(marked()).toBe(true)
    frames.splice(0, 1)[0]!(0)
    expect(marked()).toBe(false)
    expect(frames).toHaveLength(0)

    // A reported resize re-arms, and disposing with that frame pending cancels it.
    resizers[0]!()
    expect(frames).toHaveLength(1)
    stop()
    expect(cancelled).toHaveLength(1)
    expect(disconnected).toBe(1)
    expect(marked()).toBe(false)
    await flushMutations()
  })

  it('watches no boxes where the document has no ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const stop = installWindowDragRecall({ document })
    row()
    stop()
  })
})

describe('disposal', () => {
  it('never measures from a frame a seam could not cancel', async () => {
    const queue: (() => void)[] = []
    const element = row()
    const stop = installWindowDragRecall({
      document,
      // A seam whose canceller drops the frame on the floor: the frame still runs.
      scheduleFrame: (frame) => {
        queue.push(frame)
        return () => {}
      },
      watchBox: () => () => {},
    })
    expect(queue).toHaveLength(1)
    stop()
    queue.splice(0, 1)[0]!()
    expect(marked()).toBe(false)
    expect(queue).toHaveLength(0)

    // A disposed watcher also ignores the DOM it used to watch.
    element.setAttribute('class', 'after-dispose')
    await flushMutations()
    expect(queue).toHaveLength(0)
  })

  it('cancels a pending frame, clears the mark, and stops watching', async () => {
    const seams = harness()
    const element = row()
    const stop = installWindowDragRecall({
      document, scheduleFrame: seams.scheduleFrame, watchBox: seams.watchBox,
    })
    seams.runFrames()
    seams.runFrames()
    element.setAttribute('class', 'moved')
    await flushMutations()
    expect(seams.frames()).toBe(1)
    // Set the mark the way a running frame would, so disposal has to clear it.
    document.body.setAttribute(RECALL_MARK, '')
    stop()
    expect(seams.frames()).toBe(0)
    expect(marked()).toBe(false)

    element.setAttribute('class', 'after-dispose')
    await flushMutations()
    expect(seams.frames()).toBe(0)
    expect(marked()).toBe(false)
    expect(seams.disposedWatchers()).toBe(1)
  })
})
