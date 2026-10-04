import { describe, expect, it, vi } from 'vitest'
import { uiElements } from '../src/elements.ts'
import { SurfaceTable } from '../src/surfaces.ts'
import type { SurfaceHost, SurfaceSnapshot } from '../src/surfaces.ts'

const { Box, Text, Button } = uiElements()

function table(render: SurfaceHost['render'], runAction?: SurfaceHost['runAction']) {
  const report = vi.fn()
  const surfaces = new SurfaceTable({
    columns: 120,
    rows: 10,
    render,
    runAction: runAction ?? (async (_session, callback) => { await callback() }),
    report,
  })
  return { surfaces, report }
}

describe('SurfaceTable', () => {
  it('draws on first read, serializes buttons with per-drawing action ids, and keeps the generation for an unchanged tree', async () => {
    let count = 0
    const pressed: string[] = []
    const { surfaces } = table(() => Promise.resolve(Box({ children: [
      Text({ children: `count ${count}` }),
      Button({ label: 'More', hotkey: '1', onPress: () => { pressed.push('more'); count += 1 } }),
    ] })))
    const first = await surfaces.current('s1')
    expect(first).toEqual({ generation: 1, tree: [{
      type: 'Box', props: {}, children: [
        { type: 'Text', props: {}, children: ['count 0'] },
        { type: 'Button', props: { label: 'More', hotkey: '1' }, children: [], actionId: 'a0' },
      ],
    }] })
    await surfaces.refresh('s1')
    expect((await surfaces.current('s1')).generation).toBe(1)
    const after = await surfaces.press('s1', 1, 'a0')
    expect(pressed).toEqual(['more'])
    expect(after.generation).toBe(2)
    expect(JSON.stringify(after.tree)).toContain('count 1')
  })

  it('ignores a press from an earlier generation or an unknown action and reports it', async () => {
    const { surfaces, report } = table(() => Promise.resolve(Button({ label: 'Go', onPress: () => {} })))
    await surfaces.current('s1')
    expect((await surfaces.press('s1', 0, 'a0')).generation).toBe(1)
    expect((await surfaces.press('s1', 1, 'a9')).generation).toBe(1)
    expect(report).toHaveBeenCalledWith('band press ignored: a0 of generation 0 is not on the current drawing (1)')
    expect(report).toHaveBeenCalledWith('band press ignored: a9 of generation 1 is not on the current drawing (1)')
  })

  it('ends a watch when its band is forgotten, and renders no further pass for it', async () => {
    const { surfaces } = table(() => Promise.resolve(Text({ children: 'drawn' })))
    const seen: SurfaceSnapshot[] = []
    const controller = new AbortController()
    const watching = (async () => {
      for await (const snapshot of surfaces.watch('s1', controller.signal)) seen.push(snapshot)
    })()
    await vi.waitFor(() => { expect(seen).toHaveLength(1) })
    surfaces.forget('s1')
    await watching
    expect(seen).toHaveLength(1)
    await surfaces.refresh('s1')
    expect((await surfaces.current('s1')).generation).toBe(1)
  })

  it('redraws when a state slot the drawing read is written, not for other slots, and on invalidation', async () => {
    let value = 'a'
    const { surfaces } = table((sessionId) => {
      surfaces.stateRead(sessionId, 'mod\u0000value')
      return Promise.resolve(Text({ children: value }))
    })
    const seen: SurfaceSnapshot[] = []
    const controller = new AbortController()
    const watching = (async () => {
      for await (const snapshot of surfaces.watch('s1', controller.signal)) seen.push(snapshot)
    })()
    await vi.waitFor(() => { expect(seen).toHaveLength(1) })
    value = 'b'
    surfaces.stateWritten('s1', 'mod\u0000other')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(seen).toHaveLength(1)
    surfaces.stateWritten('s1', 'mod\u0000value')
    await vi.waitFor(() => { expect(seen).toHaveLength(2) })
    expect(seen[1]?.tree).toEqual([{ type: 'Text', props: {}, children: ['b'] }])
    surfaces.stateWritten('s2', 'mod\u0000value')
    controller.abort()
    await watching
    expect(seen).toHaveLength(2)
  })

  it('coalesces overlapping refreshes into one more pass, turns a failed or invalid render into an empty band, and forgets sessions', async () => {
    let renders = 0
    let mode: 'slow' | 'throw' | 'invalid' = 'slow'
    const { surfaces, report } = table(async () => {
      renders += 1
      if (mode === 'throw') throw new Error('render broke')
      if (mode === 'invalid') return { type: 'Text', props: {} } as never
      await new Promise(resolve => setTimeout(resolve, 10))
      return Text({ children: `render ${renders}` })
    })
    const a = surfaces.refresh('s1')
    const b = surfaces.refresh('s1')
    const c = surfaces.refresh('s1')
    // The two refreshes asked for during the first pass share one more pass that settles after it.
    expect(b).not.toBe(a)
    expect(c).toBe(b)
    await Promise.all([a, b, c])
    expect(renders).toBe(2)
    expect((await surfaces.current('s1')).tree).toEqual([{ type: 'Text', props: {}, children: ['render 2'] }])
    mode = 'throw'
    await surfaces.refresh('s1')
    expect((await surfaces.current('s1')).tree).toBeNull()
    expect(report).toHaveBeenCalledWith('band render failed: render broke')
    mode = 'invalid'
    await surfaces.refresh('s1')
    expect(report).toHaveBeenCalledWith('a ui.render hook returned a tree that does not validate: a tree node is object, not an element, text, or a list of them')
    surfaces.forget('s1')
    surfaces.forget('s1')
    surfaces.dispose()
    await surfaces.refresh('s1')
    expect((await surfaces.current('s1')).generation).toBe(0)
  })

  it('reports a failing onPress through the host and still redraws', async () => {
    const report = vi.fn()
    const surfaces = new SurfaceTable({
      columns: 120,
      rows: 10,
      render: () => Promise.resolve(Button({ label: 'Boom', onPress: () => { throw new Error('nope') } })),
      runAction: async (_session, callback) => {
        try {
          await callback()
        } catch (error) {
          report(`a button's onPress failed: ${(error as Error).message}`)
        }
      },
      report,
    })
    await surfaces.current('s1')
    await surfaces.press('s1', 1, 'a0')
    expect(report).toHaveBeenCalledWith("a button's onPress failed: nope")
  })
})
