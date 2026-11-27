// @vitest-environment jsdom
/** DOM ownership across real SlotRegistry elections, including retained and forwarded caller content. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createClientModuleSystem, type ClientModuleLoaderTarget } from '@deepseek-ai/dsh-client-modules/client'
import { act, fireEvent, render, type RenderResult } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { FactoryLocalComponentPropsOf, StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots/client'
import { SlotRegistry } from '../src/client/registry.ts'
import { createSlotRenderer } from '../src/client/scoped-slots.tsx'

const A = '@deepseek-ai/dsh-client-ui-layout'
const B = '@example/tree'
const C = '@example/client'
const single = { kind: 'single', scope: 'root' } as const
const keyed = { kind: 'keyed', scope: 'root' } as const
const list = { kind: 'list', scope: 'root' } as const
const chain = { kind: 'chain', scope: 'root' } as const
const hoc = { kind: 'hoc', scope: 'root' } as const
const treeChildren = { 'module-test.frame': hoc, 'module-test.list': list, 'module-test.chain': chain }
const panelChildren = { 'module-test.keyed': keyed }

interface Route { enabled: boolean }
type LayerMode = 'forward' | 'drop' | 'crash'

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  interface SlotMap {
    'module-test.single': typeof single
    'module-test.keyed': typeof keyed
    'module-test.list': typeof list
    'module-test.inline': typeof list & { inline: true }
    'module-test.chain': typeof chain & { owner: Route }
    'module-test.outer': typeof hoc & { owner: { mode: LayerMode } }
    'module-test.frame': typeof hoc
  }
  interface SlotFactoryMap {
    'module-test.tree': {
      scope: 'root'
      props: { label: string }
      children: typeof treeChildren
      slots: { tail: { scope: 'root'; props: { label: string } } }
    }
    'module-test.panel': {
      scope: 'root'
      props: { label: string; body?: ReactNode }
      children: typeof panelChildren
      slots: { tail: { scope: 'root'; props: { label: string } } }
    }
  }
}

async function setup(...scoped: string[]) {
  const ctx = new Context()
  const ids = [A, B, C]
  const target: ClientModuleLoaderTarget = {
    mode: 'queue', pendingQueue: [], load: () => {},
    create: options => createClientModuleSystem(target, { id: 'bootstrap', exports: {} }, options),
  }
  const modules = target.create({ staticModules: [], boot: {
    rev: '0', entries: ids.map(id => ({
      id, rev: '0', url: `plugins/??${id}/client.js&rev=0`, isolation: scoped.includes(id) ? 'style' : null,
    })),
    batches: [{ phase: 'application', url: 'plugins/batch', rev: '0', entries: ids }],
  } })
  ctx.provide('modules', modules)
  let view: RenderResult | undefined
  onTestFinished(async () => {
    view?.unmount()
    try { await ctx.fiber.dispose() } finally { await modules.dispose() }
  })
  await ctx.plugin(Loader)
  ctx.loader.internal = modules as never
  await ctx.plugin(SlotRegistry).await()
  const binding: StandardSourceBinding = { key: undefined, hooks: {}, keyedHooks: {}, props: {} }
  const current = { getSnapshot: () => binding, subscribe: () => () => {} }
  ctx.slots.installScope('session', { current, bindingSource: () => current })
  ctx.slots.install(createSlotRenderer())
  async function packageSlots(id: string, specifier = id) {
    let slots!: SlotRegistry
    target.load({ id, factory: () => ({ inject: ['slots'], apply(owner: Context) {
      slots = owner.isolate('modules').slots
    } }) })
    await ctx.loader.create({ name: specifier })
    await ctx.loader.await()
    return slots
  }
  return {
    // B is imported through an alias; C's actual package name ends with /client.
    a: await packageSlots(A), b: await packageSlots(B, `${B}/client`), c: await packageSlots(C), unnamed: ctx.slots,
    mount: () => {
      view = render(<>{ctx.slots.renderSlot('root', {})}</>)
      return view
    },
  }
}

function supplier(node: Element | null | undefined) {
  if (!node) throw new Error('expected a rendered element')
  return node.getAttribute('data-plugin')
}

function crash(): never { throw new Error('test entry crashed') }

function quietCrashes() {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() => { spy.mockRestore() })
}

function Counter() {
  const [count, set] = useState(0)
  return <><button onClick={() => { set(count + 1) }}>{count}</button><em>second</em></>
}

describe('module ownership on existing Slot elements', () => {
  it('keeps the shared list transparent, marks each winner and preserves the surviving row across filter changes', async () => {
    const { a, b, unnamed, mount } = await setup(A)
    const children = { 'module-test.list': list, 'module-test.inline': { ...list, inline: true } } as const
    a.register({ name: 'root', children }, ({ renderSlot }) => {
      const [only, set] = useState<string>()
      return <>
        <button onClick={() => { set('count') }}>Only counter</button>
        <button onClick={() => { set('missing') }}>Miss</button>
        <button onClick={() => { set(undefined) }}>All</button>
        {renderSlot('module-test.list', {}, { ...(only === undefined ? {} : { only }), fallback: <i>missing</i> })}
        {renderSlot('module-test.inline', {}, { only: 'text' })}
      </>
    })
    a.register({ name: 'module-test.list', id: 'count' }, Counter)
    b.register({ name: 'module-test.list', id: 'text', order: 1 }, () => 'text')
    unnamed.register({ name: 'module-test.list', id: 'empty', order: 2, registrant: 'not-a-package' }, () => null)
    b.register({ name: 'module-test.inline', id: 'text' }, () => 'inline text')
    const view = mount()
    const root = view.container.firstElementChild!
    const outlet = root.querySelector(':scope > [data-slot="module-test.list"]')!
    const inline = root.querySelector(':scope > span[data-slot="module-test.inline"]')!
    expect(supplier(root)).toEqual(A)
    expect(supplier(outlet)).toEqual(null)
    expect(supplier(inline)).toEqual(null)
    expect(supplier(inline.querySelector(':scope > span[data-slot-item]:only-child'))).toEqual(B)
    const rows = [...outlet.children]
    expect(rows.every(row => row.matches('div[data-slot-item=""]'))).toBe(true)
    expect(rows.map(supplier)).toEqual([A, B, ''])
    expect(rows.map(row => row.innerHTML)).toEqual(['<button>0</button><em>second</em>', 'text', ''])

    const button = rows[0]!.firstElementChild!
    fireEvent.click(button)
    fireEvent.click(view.getByText('Only counter'))
    expect([...outlet.children]).toEqual([rows[0]])
    expect(supplier(outlet)).toEqual(null)
    expect(outlet.firstElementChild).toBe(rows[0])
    expect(rows[0]!.firstElementChild).toBe(button)
    expect(button.textContent).toBe('1')

    fireEvent.click(view.getByText('Miss'))
    expect(supplier(outlet)).toEqual(A)
    expect(outlet.innerHTML).toBe('<i>missing</i>')
    fireEvent.click(view.getByText('All'))
    expect(supplier(outlet)).toEqual(null)
    expect([...outlet.children].map(supplier)).toEqual([A, B, ''])
  })

  it('labels single and keyed winners, caller fallbacks and neutral exhausted cells', async () => {
    quietCrashes()
    const { a, b, c, mount } = await setup(B)
    const children = { 'module-test.single': single, 'module-test.keyed': keyed, 'module-test.list': list }
    a.register({ name: 'root', children }, ({ renderSlot }) => <>
      {renderSlot('module-test.single', {}, { fallback: <i>single fallback</i> })}
      {renderSlot('module-test.keyed', {}, { entryKey: 'x', fallback: <i>keyed fallback</i> })}
      {renderSlot('module-test.list', {}, { only: 'x', fallback: <i>list fallback</i> })}
    </>)
    const release = c.register({ name: 'module-test.single' }, () => 'second')
    const releaseWinner = b.register({ name: 'module-test.single', priority: -1 }, () => 'first')
    b.register({ name: 'module-test.keyed', key: 'other' }, () => 'not this key')
    b.register({ name: 'module-test.list', id: 'other' }, () => 'not this id')
    const view = mount()
    const outlets = [...view.container.firstElementChild!.children]
    expect(outlets.map(supplier)).toEqual([B, A, A])
    expect(outlets.map(node => node.textContent)).toEqual(['first', 'keyed fallback', 'list fallback'])
    await act(async () => { releaseWinner() })
    expect(supplier(outlets[0])).toEqual(C)
    await act(async () => { release() })
    expect(supplier(outlets[0])).toEqual(A)
    expect(outlets[0]!.innerHTML).toBe('<i>single fallback</i>')
    let releaseKey!: () => void
    await act(async () => { releaseKey = c.register({ name: 'module-test.keyed', key: 'x' }, () => null) })
    expect(supplier(outlets[1])).toEqual(C)
    expect(outlets[1]!.childNodes).toHaveLength(0)
    await act(async () => {
      b.register({ name: 'module-test.single' }, crash)
      b.register({ name: 'module-test.keyed', key: 'x', priority: -1 }, crash)
      b.register({ name: 'module-test.list', id: 'x' }, crash)
    })
    expect(supplier(outlets[1])).toEqual(C)
    await act(async () => { releaseKey() })
    for (const outlet of outlets) {
      expect(supplier(outlet)).toEqual(null)
      expect(supplier(outlet.querySelector(':scope > [data-slot-error]:only-child'))).toEqual('')
    }
  })

  it('keeps Factory errors neutral inside the correct inline roots, and leaves only the neutral error when root exhausts', async () => {
    quietCrashes()
    const { a, b, mount } = await setup(A, B)
    const releaseRoot = a.register({ name: 'root' }, ({ renderFactorySlot }) => <>
      {renderFactorySlot('module-test.tree', { label: 'body' })}
      {renderFactorySlot('module-test.tree', { label: 'local' }, { slots: { tail: crash } })}
      {renderFactorySlot('module-test.tree', { label: 'default' })}
    </>)
    b.register({ name: 'root', priority: 1 }, crash)
    b.registerFactory({ name: 'module-test.tree', scope: 'root', inline: true, children: treeChildren, slots: { tail: { scope: 'root' } } },
      ({ useFactorySlot, label }) => {
        const View = useFactorySlot('tail', crash)
        if (label === 'body') return crash()
        return <View label={label} />
      })
    const view = mount()
    const [body, custom, fallback] = [...view.container.querySelectorAll('span[data-slot-factory]')]
    expect([body, custom, fallback].map(supplier)).toEqual([B, B, B])
    expect(supplier(body!.querySelector(':scope > span[data-factory-error]:only-child'))).toEqual('')
    const local = custom!.querySelector(':scope > div[data-slot-factory-children]:only-child')!
    expect(supplier(local)).toEqual(A)
    for (const parent of [local, fallback!]) {
      expect(supplier(parent.querySelector(':scope > div[data-factory-error]:only-child'))).toEqual('')
    }
    await act(async () => { releaseRoot() })
    expect(supplier(view.container.querySelector(':scope > div[data-slot-error="root"]:only-child'))).toEqual('')
    expect(view.container.querySelector('[data-slot="root"]')).toBeNull()
  })

  it.each([false, true])('elects a chain once, and keeps fallback ownership on fallbackOnly changes (overlay=%s)', async (overlay) => {
    const { a, b, mount } = await setup(A, B)
    const select = vi.fn(({ enabled }: Route) => enabled ? 'winner' : null)
    a.register({ name: 'root', children: { 'module-test.chain': chain } }, ({ renderSlotChain }) => {
      const [mode, set] = useState<'win' | 'miss' | 'skip'>('win')
      return <>
        <button onClick={() => { set('skip') }}>Skip</button><button onClick={() => { set('miss') }}>Miss</button>
        {renderSlotChain('module-test.chain', { enabled: mode !== 'miss' }, {
          fallback: <input defaultValue="kept" />, overlay, fallbackOnly: mode === 'skip',
        })}
      </>
    })
    b.register({ name: 'module-test.chain', select }, ({ matched }) => <em>{matched}</em>)
    const view = mount()
    const root = view.container.firstElementChild!
    const outlet = root.querySelector(':scope > [data-slot="module-test.chain"]')!
    const fallback = outlet.querySelector<HTMLElement>(':scope > [data-chain-overlay-fallback]')
    const control = fallback?.firstElementChild
    expect(select).toHaveBeenCalledTimes(1)
    expect(supplier(root)).toEqual(A)
    expect(supplier(outlet)).toEqual(B)
    expect([...outlet.children]).toEqual([...(overlay ? [fallback] : []), view.getByText('winner')])
    if (overlay) {
      expect(supplier(fallback)).toEqual(A)
      expect(fallback?.style.display).toBe('none')
    }
    fireEvent.click(view.getByText('Skip'))
    expect(select).toHaveBeenCalledTimes(1)
    expect(supplier(outlet)).toEqual(A)
    fireEvent.click(view.getByText('Miss'))
    expect(select).toHaveBeenCalledTimes(2)
    expect(supplier(outlet)).toEqual(A)
    if (overlay) {
      expect([...outlet.children]).toEqual([fallback])
      expect(fallback?.firstElementChild).toBe(control)
      expect(fallback?.style.display).toBe('contents')
    } else {
      expect(outlet.querySelector(':scope > input:only-child')).not.toBeNull()
    }
  })

  it('keeps the next layer and original caller on forwarded, skipped and crashed HOC occurrences', async () => {
    quietCrashes()
    const { a, b, c, unnamed, mount } = await setup(A, B)
    a.register({ name: 'root', children: { 'module-test.outer': hoc } }, ({ renderSlot }) => (
      (['forward', 'drop', 'crash'] as const).map(mode => <section key={mode}>
        {renderSlot('module-test.outer', { mode }, { children: <button>{mode}</button> })}
      </section>)
    ))
    const view = mount()
    const outlets = [...view.container.querySelectorAll('[data-slot="module-test.outer"]')]
    expect(outlets.map(supplier)).toEqual([A, A, A])
    await act(async () => {
      b.register({ name: 'module-test.outer', id: 'bridge', children: { 'module-test.frame': hoc } }, ({ mode, children, renderSlot }) => {
        if (mode === 'crash') return crash()
        if (mode === 'drop') return <b>Dropped</b>
        return renderSlot('module-test.frame', {}, { children: <>{children}<button>extra</button></> })
      })
      unnamed.register({ name: 'module-test.outer', id: 'inner', order: 1 }, ({ children }) => children)
      c.register({ name: 'module-test.frame', id: 'receiver' }, ({ children }) => children)
    })
    expect(outlets.map(supplier)).toEqual([B, B, B])
    const receiver = outlets[0]!.querySelector(':scope > [data-slot="module-test.frame"]')!
    const group = receiver.querySelector(':scope > [data-slot-children="module-test.frame"]')!
    const inner = group.querySelector(':scope > [data-slot-children="module-test.outer"]')!
    const original = inner.querySelector(':scope > [data-slot-children="module-test.outer"]')!
    expect([receiver, group, inner, original].map(supplier)).toEqual([C, B, '', A])
    expect(view.getByText('forward').parentElement).toBe(original)
    expect(view.getByText('extra').parentElement).toBe(group)
    expect(outlets[1]!.innerHTML).toBe('<b>Dropped</b>')
    const remaining = outlets[2]!.querySelector(':scope > [data-slot-children]')!
    expect(supplier(remaining)).toEqual('')
    expect(supplier(remaining.firstElementChild)).toEqual(A)
    expect(view.getByText('crash').parentElement).toBe(remaining.firstElementChild)
  })
})

function Tail({ label, renderSlot, renderSlotChain }: FactoryLocalComponentPropsOf<'module-test.tree', 'tail'>) {
  return <>
    {renderSlot('module-test.frame', {}, { children: <button>{label}</button> })}
    {renderSlot('module-test.list', {}, { only: 'missing', fallback: <i>{label}</i> })}
    {renderSlotChain('module-test.chain', { enabled: false }, { fallback: <em>{label}</em>, overlay: true })}
  </>
}

async function factoryTree(...scoped: string[]) {
  const { a, b, c, mount } = await setup(...scoped)
  a.register({ name: 'root', children: { 'module-test.single': single } }, ({ renderFactorySlot, renderSlot }) => <>
    {renderFactorySlot('module-test.tree', { label: 'A' }, { slots: { tail: Tail } })}
    {renderSlot('module-test.single', {})}
    {renderFactorySlot('module-test.tree', { label: 'default' })}
  </>)
  c.register({ name: 'module-test.single' }, ({ renderFactorySlot }) => (
    renderFactorySlot('module-test.tree', { label: 'C' }, { slots: { tail: Tail } })
  ))
  const removeTree = b.registerFactory({
    name: 'module-test.tree', scope: 'root', children: treeChildren, slots: { tail: { scope: 'root', inline: true } },
  }, ({ useFactorySlot, label }) => {
    const View = useFactorySlot('tail', Tail)
    return <View label={label} />
  })
  b.register({ name: 'module-test.frame', id: 'same-compiled-chain' }, ({ children }) => children)
  return { view: mount(), removeTree }
}

it('uses each Factory caller for selected locals and their borrowed Slot bindings without adding DOM', async () => {
  const baseline = await factoryTree()
  const { view, removeTree } = await factoryTree(B, C)
  const root = view.container.firstElementChild!
  expect(supplier(root)).toEqual(A)
  const trees = [...root.querySelectorAll('[data-slot-factory="module-test.tree"]')]
  expect(trees.map(supplier)).toEqual([B, B, B])
  for (const [i, name] of [A, C, B].entries()) {
    const tree = trees[i]!
    const local = tree.querySelector(':scope > span[data-slot-factory-children="module-test.tree:tail"]')
    if (i === 2) expect(local).toBeNull()
    else expect(supplier(local)).toEqual(name)
    const [frame, rows, route] = [...(local ?? tree).children]
    expect(supplier(frame)).toEqual(B)
    expect(supplier(frame!.querySelector(':scope > [data-slot-children]'))).toEqual(name)
    expect(supplier(rows)).toEqual(name)
    expect(rows!.firstElementChild?.tagName).toBe('I')
    expect(supplier(route)).toEqual(name)
    expect(supplier(route!.querySelector(':scope > [data-chain-overlay-fallback]'))).toEqual(name)
  }
  expect(root.outerHTML).toBe(baseline.view.container.firstElementChild!.outerHTML)
  expect(view.container.querySelector('[data-plugin-scopestyle]')).toBeNull()
  await act(async () => { removeTree() })
  expect(root.querySelector('[data-slot-factory]')).toBeNull()
  expect(root.children).toHaveLength(1)
})

type TailProps = FactoryLocalComponentPropsOf<'module-test.tree', 'tail'>
type PanelTailProps = FactoryLocalComponentPropsOf<'module-test.panel', 'tail'>
type UntypedRender = (key: string, owner: object) => ReactNode

function registerTree(slots: SlotRegistry) {
  const remove = slots.registerFactory({
    name: 'module-test.tree', scope: 'root', children: treeChildren, slots: { tail: { scope: 'root' } },
  }, ({ useFactorySlot, label }) => {
    const View = useFactorySlot('tail', Tail)
    return <View label={label} />
  })
  slots.register({ name: 'module-test.frame', id: 'layer' }, ({ children }) => children)
  return remove
}

describe('child slots a caller-selected Factory local renders', () => {
  it('gives each caller one binding for its locals wherever they mount, and the Factory another for itself', async () => {
    const { a, b, c, mount } = await setup(A, C)
    const selected: TailProps[] = []
    const fallbacks: TailProps[] = []
    const bodies: Pick<TailProps, 'renderSlot' | 'renderSlotChain'>[] = []
    const Selected = (props: TailProps) => {
      selected.push(props)
      return <Tail {...props} />
    }
    const Fallback = (props: TailProps) => {
      fallbacks.push(props)
      return <Tail {...props} />
    }
    let rerender!: () => void
    a.register({ name: 'root', children: { 'module-test.single': single } }, ({ renderFactorySlot, renderSlot }) => {
      const [, set] = useState(0)
      rerender = () => { set(count => count + 1) }
      return <>
        {['one', 'two', 'three'].map(label => (
          <section key={label}>{renderFactorySlot('module-test.tree', { label }, { slots: { tail: Selected } })}</section>
        ))}
        {renderSlot('module-test.single', {})}
        {renderFactorySlot('module-test.tree', { label: 'default' })}
      </>
    })
    c.register({ name: 'module-test.single' }, ({ renderFactorySlot }) => (
      renderFactorySlot('module-test.tree', { label: 'C' }, { slots: { tail: Selected } })
    ))
    const removeTree = b.registerFactory({
      name: 'module-test.tree', scope: 'root', children: treeChildren, slots: { tail: { scope: 'root' } },
    }, ({ useFactorySlot, label, renderSlot, renderSlotChain }) => {
      bodies.push({ renderSlot, renderSlotChain })
      const View = useFactorySlot('tail', Fallback)
      return <View label={label} />
    })
    b.register({ name: 'module-test.frame', id: 'layer' }, ({ children }) => children)
    const view = mount()

    const distinct = (values: unknown[]) => new Set(values).size
    const expectSharedBindings = () => {
      // One caller mounting its local in several places needs one binding, not one per place.
      const fromA = selected.filter(props => props.label !== 'C')
      expect(distinct(fromA.map(props => props.renderSlot))).toBe(1)
      expect(distinct(fromA.map(props => props.renderSlotChain))).toBe(1)
      // A and C pass the same arguments and must be told apart, so each caller has its own binding.
      expect(distinct(selected.map(props => props.renderSlot))).toBe(2)
      expect(distinct(selected.map(props => props.renderSlotChain))).toBe(2)
      // A fallback local is the Factory's own content, so it shares the Factory's binding.
      expect(distinct([...bodies, ...fallbacks].map(props => props.renderSlot))).toBe(1)
      expect(distinct([...bodies, ...fallbacks].map(props => props.renderSlotChain))).toBe(1)
      expect(selected[0]!.renderSlot).not.toBe(bodies[0]!.renderSlot)
      expect(selected[0]!.renderSlotChain).not.toBe(bodies[0]!.renderSlotChain)
    }
    expect([selected.length, bodies.length, fallbacks.length]).toEqual([4, 5, 1])
    expectSharedBindings()
    await act(async () => { rerender() })
    expect(selected.length).toBeGreaterThan(4)
    expectSharedBindings()

    const trees = [...view.container.querySelectorAll('[data-slot-factory="module-test.tree"]')]
    expect(trees.map(supplier)).toEqual([B, B, B, B, B])
    for (const [i, name] of [A, A, A, C, B].entries()) {
      const tree = trees[i]!
      const local = tree.querySelector(':scope > [data-slot-factory-children="module-test.tree:tail"]')
      if (name === B) expect(local).toBeNull()
      else expect(supplier(local)).toEqual(name)
      const [frame, rows, route] = [...(local ?? tree).children]
      expect(supplier(frame)).toEqual(B)
      expect(supplier(frame!.querySelector(':scope > [data-slot-children="module-test.frame"]'))).toEqual(name)
      expect(supplier(rows)).toEqual(name)
      expect(supplier(route!.querySelector(':scope > [data-chain-overlay-fallback]'))).toEqual(name)
    }

    const render = selected[0]!.renderSlot as UntypedRender
    const renderChain = selected[0]!.renderSlotChain as UntypedRender
    expect(() => render('module-test.chain', {})).toThrow(/use renderSlotChain/)
    expect(() => renderChain('module-test.list', {})).toThrow(/not 'chain'/)
    expect(() => render('module-test.single', {})).toThrow(/not declared by this Factory/)
    expect(() => renderChain('module-test.single', {})).toThrow(/not declared by this Factory/)
    await act(async () => { removeTree() })
    expect(() => render('module-test.list', {})).toThrow(/disposed Factory/)
    expect(() => renderChain('module-test.chain', {})).toThrow(/disposed Factory/)
  })

  it('names the supplier at each level of nested child slots and nested Factories', async () => {
    const { a, b, c, mount } = await setup(A, B, C)
    const Deep = ({ renderSlot }: PanelTailProps) => (
      renderSlot('module-test.keyed', {}, { entryKey: 'none', fallback: <u>deep</u> })
    )
    const Nested = ({ renderSlot }: TailProps) => renderSlot('module-test.frame', {}, {
      children: <>
        {renderSlot('module-test.list', {}, { only: 'missing', fallback: <i>inner</i> })}
        {renderSlot('module-test.list', {}, { only: 'nested' })}
      </>,
    })
    a.register({ name: 'root' }, ({ renderFactorySlot }) => (
      renderFactorySlot('module-test.tree', { label: 'outer' }, { slots: { tail: Nested } })
    ))
    registerTree(b)
    a.registerFactory({
      name: 'module-test.panel', scope: 'root', children: panelChildren, slots: { tail: { scope: 'root' } },
    }, ({ useFactorySlot, label }) => {
      const View = useFactorySlot('tail', () => null)
      return <View label={label} />
    })
    c.register({ name: 'module-test.list', id: 'nested' }, ({ renderFactorySlot }) => (
      renderFactorySlot('module-test.panel', { label: 'inner' }, { slots: { tail: Deep } })
    ))
    const view = mount()

    const tree = view.container.querySelector('[data-slot-factory="module-test.tree"]')!
    const local = tree.querySelector(':scope > [data-slot-factory-children="module-test.tree:tail"]')!
    const frame = local.querySelector(':scope > [data-slot="module-test.frame"]')!
    const passed = frame.querySelector(':scope > [data-slot-children="module-test.frame"]')!
    const [missing, rows] = [...passed.children]
    const row = rows!.querySelector(':scope > [data-slot-item]')!
    const panel = row.querySelector(':scope > [data-slot-factory="module-test.panel"]')!
    const panelLocal = panel.querySelector(':scope > [data-slot-factory-children="module-test.panel:tail"]')!
    const deep = panelLocal.querySelector(':scope > [data-slot="module-test.keyed"]')!
    // B's Factory > A's local > B's layer > what A passed in > (A's fallback | C's row > A's Factory > C's local > C's fallback).
    expect([tree, local, frame, passed, missing, rows, row, panel, panelLocal, deep].map(supplier))
      .toEqual([B, A, B, A, A, null, C, A, C, C])
    expect(missing!.innerHTML).toBe('<i>inner</i>')
    expect(deep.innerHTML).toBe('<u>deep</u>')
  })

  it('keeps the creator on an outlet that another caller of the same Factory only mounts', async () => {
    const { a, b, c, mount } = await setup(A, B, C)
    let parked: ReactNode = null
    const Park = ({ renderSlot }: TailProps) => {
      parked = <>
        {renderSlot('module-test.frame', {}, { children: <button>from A</button> })}
        {renderSlot('module-test.list', {}, { only: 'missing', fallback: <i>from A</i> })}
      </>
      return null
    }
    const Mount = (_props: TailProps) => parked
    a.register({ name: 'root', children: { 'module-test.single': single } }, ({ renderFactorySlot, renderSlot }) => <>
      {renderFactorySlot('module-test.tree', { label: 'A' }, { slots: { tail: Park } })}
      {renderSlot('module-test.single', {})}
    </>)
    c.register({ name: 'module-test.single' }, ({ renderFactorySlot }) => (
      renderFactorySlot('module-test.tree', { label: 'C' }, { slots: { tail: Mount } })
    ))
    registerTree(b)
    const view = mount()

    const local = [...view.container.querySelectorAll('[data-slot-factory-children="module-test.tree:tail"]')][1]!
    expect(supplier(local)).toEqual(C)
    const [frame, rows] = [...local.children]
    expect(supplier(frame)).toEqual(B)
    // A wrote the button and the fallback; C's local only returns the element A created.
    expect(view.getByText('from A', { selector: 'button' }).parentElement).toBe(frame!.querySelector(':scope > [data-slot-children]'))
    expect(supplier(frame!.querySelector(':scope > [data-slot-children="module-test.frame"]'))).toEqual(A)
    expect(rows!.innerHTML).toBe('<i>from A</i>')
    expect(supplier(rows)).toEqual(A)
  })

  it('keeps the creator on an outlet handed to a nested Factory as a prop', async () => {
    const { a, b, c, mount } = await setup(A, B, C)
    const Hand = ({ renderSlot, renderFactorySlot }: TailProps) => renderFactorySlot('module-test.panel', {
      label: 'panel',
      body: renderSlot('module-test.list', {}, { only: 'missing', fallback: <i>from A</i> }),
    })
    a.register({ name: 'root' }, ({ renderFactorySlot }) => (
      renderFactorySlot('module-test.tree', { label: 'A' }, { slots: { tail: Hand } })
    ))
    registerTree(b)
    c.registerFactory({
      name: 'module-test.panel', scope: 'root', children: panelChildren, slots: { tail: { scope: 'root' } },
    }, ({ body }) => <>{body}</>)
    const view = mount()

    const panel = view.container.querySelector('[data-slot-factory="module-test.panel"]')!
    expect(supplier(panel)).toEqual(C)
    const rows = panel.querySelector(':scope > [data-slot="module-test.list"]')!
    expect(rows.innerHTML).toBe('<i>from A</i>')
    // A wrote the fallback; C's Factory only renders the element it was handed.
    expect(supplier(rows)).toEqual(A)
  })

  it('keeps the creator when a local calls its Factory\'s child slot from inside another Factory', async () => {
    const { a, b, c, mount } = await setup(A, B, C)
    const Bridge = ({ renderSlot, renderFactorySlot }: TailProps) => {
      const [Inner] = useState(() => () => renderSlot('module-test.list', {}, { only: 'missing', fallback: <i>from A</i> }))
      return renderFactorySlot('module-test.panel', { label: 'panel' }, { slots: { tail: Inner } })
    }
    a.register({ name: 'root' }, ({ renderFactorySlot }) => (
      renderFactorySlot('module-test.tree', { label: 'A' }, { slots: { tail: Bridge } })
    ))
    registerTree(b)
    c.registerFactory({
      name: 'module-test.panel', scope: 'root', children: panelChildren, slots: { tail: { scope: 'root' } },
    }, ({ useFactorySlot, label }) => {
      const View = useFactorySlot('tail', () => null)
      return <View label={label} />
    })
    const view = mount()

    const panel = view.container.querySelector('[data-slot-factory="module-test.panel"]')!
    const local = panel.querySelector(':scope > [data-slot-factory-children="module-test.panel:tail"]')!
    const rows = local.querySelector(':scope > [data-slot="module-test.list"]')!
    // C defines the panel; A selected its local and, inside it, called the tree's child slot with A's fallback.
    expect([panel, local, rows].map(supplier)).toEqual([C, A, A])
    expect(rows.innerHTML).toBe('<i>from A</i>')
  })
})
