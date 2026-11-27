// Dynamic-key escape hatches and untouched-key behavior of the terminal core.
import { describe, expect, it } from 'vitest'
import type { SlotComponent } from '@deepseek-ai/dsh-client-ui-slots/client'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots/client'

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  interface SlotMap {
    'dynamic.a': { kind: 'single'; scope: 'root' }
    'dynamic.b': { kind: 'single'; scope: 'root' }
    'surface.injected': { kind: 'single'; scope: 'root'; inject: { token: string } }
  }
}

const Comp: SlotComponent<object> = () => null

describe('dynamic-key escape hatch', () => {
  it('specDynamic reads wide-typed specs for string keys; undefined while undeclared', () => {
    const core = new SlotCore()
    expect(core.specDynamic('dynamic.a')).toBeUndefined()
    core.register({ name: 'root', children: { 'dynamic.a': { kind: 'single', scope: 'root' } } }, Comp as never)
    expect(core.specDynamic('dynamic.a')).toEqual({ kind: 'single', scope: 'root' })
    expect(core.specDynamic('never.declared')).toBeUndefined()
  })

  it('spec() narrows by SlotMap key', () => {
    const core = new SlotCore()
    core.register({ name: 'root', children: { 'dynamic.a': { kind: 'single', scope: 'root' } } }, Comp as never)
    expect(core.spec('dynamic.a')).toEqual({ kind: 'single', scope: 'root' })
    expect(core.spec('dynamic.b')).toBeUndefined()
  })

  it('records the parent-declared Slot inject on the runtime spec', () => {
    const core = new SlotCore()
    const inject = { token: 'shared' }
    core.register({
      name: 'root',
      children: { 'surface.injected': { kind: 'single', scope: 'root', inject } },
    }, Comp as never)
    expect(core.spec('surface.injected')?.inject).toBe(inject)
  })

  it('entries/getVersion on an untouched key return the frozen empty array and 0', () => {
    const core = new SlotCore()
    expect(core.entries('dynamic.b')).toHaveLength(0)
    expect(core.entries('dynamic.b')).toBe(core.entries('dynamic.b'))
    expect(core.getVersion('dynamic.b')).toBe(0)
  })

  it('isLive is false for entries the core never held', () => {
    const core = new SlotCore()
    expect(core.isLive({ component: Comp, options: {} })).toBe(false)
  })
})
