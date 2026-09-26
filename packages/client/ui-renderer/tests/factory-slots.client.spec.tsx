// @vitest-environment jsdom
import { StrictMode, useEffect, useState, type ReactNode } from 'react'
import { act, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  ActionsDecl, FactoryComponentPropsOf, FactoryLocalComponentPropsOf, HostObservable,
  PropsRenderFactories, PropsRuntime, StoreHandle, StoreInstanceLike,
} from '@deepseek-ai/dsh-client-ui-slots'
import { StaleAuthorizationError } from '@deepseek-ai/dsh-client-ui-slots'

interface CounterState { count: number }
interface CounterActions extends ActionsDecl<CounterState> {
  increment(draft: CounterState): void
}
type CounterStore = StoreHandle<CounterState, CounterActions>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'renderer.factory.child': { kind: 'list'; scope: 'root' }
    'renderer.factory.chain': { kind: 'chain'; scope: 'root'; owner: { enabled: boolean } }
    'renderer.factory.session-area': { kind: 'single'; scope: 'session' }
  }

  interface LocaleNamespaceMap {
    'renderer-factory': 'word'
  }

  interface SlotFactoryMap {
    'renderer.factory': {
      scope: 'root'
      props: { label: string; crash?: boolean }
      children: { 'renderer.factory.child': { kind: 'list'; scope: 'root' } }
      store: CounterStore
      inject: {
        hooks: { suffix: HostObservable<string> }
        tag: string
      }
      locale: 'renderer-factory'
      slots: {
        view: { scope: 'root'; props: { text: string } }
      }
    }
    'renderer.recursive-factory': { scope: 'root' }
    'renderer.session-store-factory': {
      scope: 'session'
      store: CounterStore
    }
    'renderer.scoped-local-factory': {
      scope: 'root'
      slots: { view: { scope: 'session' } }
    }
    'renderer.nested-factory': {
      scope: 'root'
      slots: { view: { scope: 'root' } }
    }
    'renderer.session-factory-root-local': {
      scope: 'session'
      props: { report: (hasSessionId: boolean) => void }
      slots: { view: { scope: 'root'; props: { report: (hasSessionId: boolean) => void } } }
    }
    'renderer.session-error-factory': {
      scope: 'session'
      props: { crashIn: string }
    }
    'renderer.error-factory': { scope: 'root' }
    'renderer.healthy-factory': { scope: 'root' }
    'renderer.chain-factory': {
      scope: 'root'
      children: {
        'renderer.factory.child': { kind: 'list'; scope: 'root' }
        'renderer.factory.chain': { kind: 'chain'; scope: 'root' }
      }
    }
  }
}

const SESSION_AREA = {
  'renderer.factory.session-area': { kind: 'single', scope: 'session' },
} as const

const sid = (value: string): SessionId => value as SessionId

function observable<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next: T) => {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

function counterHandle(clearPersisted = vi.fn()): CounterStore {
  return {
    spec: {
      init: () => ({ count: 0 }),
      actions: { increment: (draft) => { draft.count += 1 } },
    },
    create: () => {
      const source = observable<CounterState>({ count: 0 })
      return {
        ...source,
        actions: {
          increment: () => { source.set({ count: source.getSnapshot().count + 1 }) },
        },
        clearPersisted,
      } as StoreInstanceLike as ReturnType<CounterStore['create']>
    },
  }
}

type FactoryProps = FactoryComponentPropsOf<'renderer.factory'>
type LocalProps = FactoryLocalComponentPropsOf<'renderer.factory', 'view'>
type ChainFactoryProps = FactoryComponentPropsOf<'renderer.chain-factory'>
type NestedFactoryProps = FactoryComponentPropsOf<'renderer.nested-factory'>
type ScopedLocalProps = FactoryLocalComponentPropsOf<'renderer.scoped-local-factory', 'view'>

let defaultMounts = 0
let customMounts = 0

function DefaultView({ text, tag, t, useSuffix }: LocalProps) {
  useEffect(() => { defaultMounts += 1 }, [])
  return <i data-view="default">{text}:{tag}:{useSuffix(value => value)}:{t('word')}</i>
}

function CustomView({ text, tag, t, useSuffix }: LocalProps) {
  useEffect(() => { customMounts += 1 }, [])
  return <i data-view="custom">{text}:{tag}:{useSuffix(value => value)}:{t('word')}</i>
}

function CrashingView(): never {
  throw new Error('selected view crashed')
}

function SessionCrashingView({ sessionId }: ScopedLocalProps) {
  if (sessionId === 'broken') throw new Error('broken session view')
  return <span>{sessionId}</span>
}

function NestedFactoryBody({ useFactorySlot }: NestedFactoryProps) {
  const View = useFactorySlot('view', () => null)
  return <View />
}

function NestedFactoryView({ renderFactorySlot }: LocalProps) {
  return renderFactorySlot('renderer.nested-factory', {}, { slots: { view: CrashingView } })
}

function FactoryBody({
  label, crash, useStore, actions, useFactorySlot, renderSlot,
}: FactoryProps) {
  if (crash === true) throw new Error(`crash:${label}`)
  const View = useFactorySlot('view', DefaultView)
  return (
    <section data-factory={label}>
      <span data-count>{useStore(state => state.count)}</span>
      <button type="button" onClick={actions.increment}>increment {label}</button>
      <View text={label} />
      {renderSlot('renderer.factory.child', {})}
    </section>
  )
}

function installLocale(runtime: SlotTestRuntime) {
  const revision = observable({ revision: 0 })
  runtime.slots.installLocale({
    ...revision,
    bind: namespace => key => `${namespace}:${key}`,
  })
  return revision
}

function registerFactory(
  runtime: SlotTestRuntime,
  storeFactory: () => CounterStore,
  component: (props: FactoryProps) => ReactNode = FactoryBody,
): () => void {
  const suffix = observable('suffix')
  return runtime.slots.registerFactory({
    name: 'renderer.factory',
    scope: 'root',
    children: { 'renderer.factory.child': { kind: 'list', scope: 'root' } },
    store: storeFactory,
    inject: () => ({ hooks: { suffix }, tag: 'injected' }),
    locale: 'renderer-factory',
    slots: { view: { scope: 'root' } },
  }, component)
}

describe('Factory rendering', () => {
  it('reports direct test-runtime lookups before rendering and without a definition', async () => {
    const runtime = await SlotTestRuntime.create()
    expect(() => runtime.factoryOf('renderer.factory')).toThrow('before renderRoot')
    await runtime.root.declare({}, () => null)
    runtime.renderRoot()
    expect(() => runtime.factoryOf('renderer.factory')).toThrow('no definition')
    await runtime.dispose()
  })

  it('assembles inject, locale, children, local selection, and exclusive stores per occurrence', async () => {
    defaultMounts = 0
    customMounts = 0
    const runtime = await SlotTestRuntime.create()
    installLocale(runtime)
    const handles: CounterStore[] = []
    registerFactory(runtime, () => {
      const handle = counterHandle()
      handles.push(handle)
      return handle
    })
    runtime.slots.register({ name: 'renderer.factory.child', id: 'child' }, () => <small>child</small>)
    await runtime.root.declare({}, ({ renderFactorySlot }: PropsRuntime<'root'> & PropsRenderFactories) => {
      const [revision, setRevision] = useState(0)
      return (
        <>
          <button type="button" onClick={() => { setRevision(value => value + 1) }}>rerender {revision}</button>
          {renderFactorySlot('renderer.factory', { label: 'A' }, { slots: { view: CustomView } })}
          {renderFactorySlot('renderer.factory', { label: 'B' })}
        </>
      )
    })
    const view = runtime.renderRoot()

    expect(handles).toHaveLength(2)
    expect(view.getByText('A:injected:suffix:renderer-factory:word').getAttribute('data-view')).toBe('custom')
    expect(view.getByText('B:injected:suffix:renderer-factory:word').getAttribute('data-view')).toBe('default')
    expect(view.getAllByText('child')).toHaveLength(2)
    fireEvent.click(view.getByRole('button', { name: 'increment A' }))
    expect(view.container.querySelector('[data-factory="A"] [data-count]')?.textContent).toBe('1')
    expect(view.container.querySelector('[data-factory="B"] [data-count]')?.textContent).toBe('0')

    fireEvent.click(view.getByRole('button', { name: /rerender/u }))
    expect(customMounts).toBe(1)
    expect(defaultMounts).toBe(1)
    await runtime.dispose()
  })

  it('keeps the occurrence Store across StrictMode effect replay and renderer updates', async () => {
    const runtime = await SlotTestRuntime.create()
    const locale = installLocale(runtime)
    registerFactory(runtime, counterHandle)
    await runtime.root.declare({}, ({ renderFactorySlot }: PropsRuntime<'root'> & PropsRenderFactories) => (
      <StrictMode>{renderFactorySlot('renderer.factory', { label: 'strict' })}</StrictMode>
    ))
    const view = runtime.renderRoot()

    fireEvent.click(view.getByRole('button', { name: 'increment strict' }))
    expect(view.container.querySelector('[data-count]')?.textContent).toBe('1')
    await act(async () => { locale.set({ revision: 1 }) })
    expect(view.container.querySelector('[data-count]')?.textContent).toBe('1')
    await runtime.dispose()
  })

  it('mints one exclusive handle per rendered Session incarnation', async () => {
    const runtime = await SlotTestRuntime.create()
    await runtime.sessions.add({ id: 's1' })
    const first = runtime.sessions.retainFor(runtime.ctx, sid('s1'))
    const handles: CounterStore[] = []
    runtime.slots.registerFactory({
      name: 'renderer.session-store-factory',
      scope: 'session',
      store: () => {
        const handle = counterHandle()
        handles.push(handle)
        return handle
      },
    }, ({ useStore, sessionId }) => <span>{sessionId}:{useStore(state => state.count)}</span>)
    let selectReference: ((reference: SessionReference) => void) | undefined
    await runtime.root.declare(SESSION_AREA, ({ renderFactorySlot, SessionProvider }) => {
      const [reference, select] = useState(first)
      selectReference = select
      return (
        <SessionProvider session={reference}>
          {renderFactorySlot('renderer.session-store-factory', {})}
        </SessionProvider>
      )
    })
    const view = runtime.renderRoot()
    expect(view.container.textContent).toBe('s1:0')
    expect(handles).toHaveLength(1)

    await runtime.sessions.add({ id: 's2' })
    const second = runtime.sessions.retainFor(runtime.ctx, sid('s2'))
    await act(async () => { selectReference?.(second) })
    expect(view.container.textContent).toBe('s2:0')
    expect(handles).toHaveLength(2)
    await runtime.dispose()
  })

  it('binds a local Component to the scope at its render position', async () => {
    const runtime = await SlotTestRuntime.create()
    await runtime.sessions.add({ id: 'nested' })
    const reference = runtime.sessions.retainFor(runtime.ctx, sid('nested'))
    runtime.slots.registerFactory({
      name: 'renderer.scoped-local-factory',
      scope: 'root',
      slots: { view: { scope: 'session' } },
    }, ({ useFactorySlot }) => {
      const View = useFactorySlot('view', ({ sessionId: bound }) => <span>{bound}</span>)
      return <View />
    })
    await runtime.root.declare(SESSION_AREA, ({ renderFactorySlot, SessionProvider }) => (
      <SessionProvider session={reference}>
        {renderFactorySlot('renderer.scoped-local-factory', {})}
      </SessionProvider>
    ))

    const view = runtime.renderRoot()
    expect(view.container.textContent).toBe('nested')
    await runtime.dispose()
  })

  it('binds chain children with ordinary routing and stale-authority checks', async () => {
    const runtime = await SlotTestRuntime.create()
    let retainedRender: ChainFactoryProps['renderSlot'] | undefined
    let retainedChain: ChainFactoryProps['renderSlotChain'] | undefined
    const dispose = runtime.slots.registerFactory({
      name: 'renderer.chain-factory',
      scope: 'root',
      children: {
        'renderer.factory.child': { kind: 'list', scope: 'root' },
        'renderer.factory.chain': { kind: 'chain', scope: 'root' },
      },
    }, ({ renderSlot, renderSlotChain }) => {
      retainedRender = renderSlot
      retainedChain = renderSlotChain
      return renderSlotChain('renderer.factory.chain', { enabled: true }, { fallback: <i>none</i> })
    })
    runtime.slots.register({
      name: 'renderer.factory.chain',
      select: owner => owner.enabled ? 'selected' : null,
    }, ({ matched }) => <span>{matched}</span>)
    await runtime.root.declare({}, ({ renderFactorySlot }: PropsRuntime<'root'> & PropsRenderFactories) => (
      <>{renderFactorySlot('renderer.chain-factory', {})}</>
    ))

    const view = runtime.renderRoot()
    expect(view.container.textContent).toBe('selected')
    if (retainedRender === undefined || retainedChain === undefined) throw new Error('Factory child bindings are missing')
    const render = retainedRender as (key: string, owner: object) => ReactNode
    const renderChain = retainedChain as (key: string, owner: object) => ReactNode
    expect(() => render('renderer.factory.chain', {})).toThrow(/use renderSlotChain/)
    expect(() => renderChain('renderer.factory.child', {})).toThrow(/not 'chain'/)
    dispose()
    expect(() => renderChain('renderer.factory.chain', { enabled: true })).toThrow(/disposed Factory/)
    await runtime.dispose()
  })

  it('gives a local Component only its own scope standard props', async () => {
    const runtime = await SlotTestRuntime.create()
    await runtime.sessions.add({ id: 'outer-session' })
    const first = runtime.sessions.retainFor(runtime.ctx, sid('outer-session'))
    const report = vi.fn()
    let mounts = 0
    runtime.slots.registerFactory({
      name: 'renderer.session-factory-root-local',
      scope: 'session',
      slots: { view: { scope: 'root' } },
    }, ({ report, sessionId: outerSessionId, useFactorySlot }) => {
      useEffect(() => { mounts += 1 }, [])
      const View = useFactorySlot('view', (props) => {
        props.report(Object.hasOwn(props, 'sessionId'))
        return <span>{outerSessionId}</span>
      })
      return <View report={report} />
    })
    let selectReference: ((reference: SessionReference) => void) | undefined
    await runtime.root.declare(SESSION_AREA, ({ renderFactorySlot, SessionProvider }) => {
      const [reference, select] = useState(first)
      selectReference = select
      return (
        <SessionProvider session={reference}>
          {renderFactorySlot('renderer.session-factory-root-local', { report })}
        </SessionProvider>
      )
    })

    const view = runtime.renderRoot()
    expect(view.container.textContent).toBe('outer-session')
    expect(report).toHaveBeenCalledWith(false)
    expect(mounts).toBe(1)
    await runtime.sessions.add({ id: 'second-session' })
    const second = runtime.sessions.retainFor(runtime.ctx, sid('second-session'))
    await act(async () => { selectReference?.(second) })
    expect(view.container.textContent).toBe('second-session')
    expect(mounts).toBe(2)
    await runtime.dispose()
  })

  it('fails loud when a strict local Component has no current scope binding', async () => {
    const runtime = await SlotTestRuntime.create()
    runtime.slots.registerFactory({
      name: 'renderer.scoped-local-factory',
      scope: 'root',
      slots: { view: { scope: 'session' } },
    }, ({ useFactorySlot }) => {
      const View = useFactorySlot('view', () => null)
      return <View />
    })
    await runtime.root.declare({}, ({ renderFactorySlot }: PropsRuntime<'root'> & PropsRenderFactories) => (
      <>{renderFactorySlot('renderer.scoped-local-factory', {})}</>
    ))

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => runtime.renderRoot()).toThrow(/strict session local slot 'view'/)
    spy.mockRestore()
    await runtime.dispose()
  })

  it('renders a fallback until a definition appears and restores it after disposal', async () => {
    const runtime = await SlotTestRuntime.create()
    installLocale(runtime)
    await runtime.root.declare({}, ({ renderFactorySlot }: PropsRuntime<'root'> & PropsRenderFactories) => (
      <>{renderFactorySlot('renderer.factory', { label: 'A' }, { fallback: <b>missing</b> })}</>
    ))
    const view = runtime.renderRoot()
    expect(view.container.textContent).toBe('missing')

    let dispose = () => {}
    await act(async () => { dispose = registerFactory(runtime, counterHandle) })
    expect(view.container.querySelector('[data-factory="A"]')).not.toBeNull()
    await act(async () => { dispose() })
    expect(view.container.textContent).toBe('missing')

    await act(async () => {
      registerFactory(runtime, counterHandle, props => <strong>replacement:{props.label}</strong>)
    })
    expect(view.container.textContent).toBe('replacement:A')
    await runtime.dispose()
  })

  it('contains a component crash to its occurrence', async () => {
    const runtime = await SlotTestRuntime.create()
    installLocale(runtime)
    registerFactory(runtime, counterHandle)
    const reported = vi.fn()
    runtime.slots.onEntryError(reported)
    await runtime.root.declare({}, ({ renderFactorySlot }: PropsRuntime<'root'> & PropsRenderFactories) => (
      <>
        {renderFactorySlot('renderer.factory', { label: 'bad', crash: true })}
        {renderFactorySlot('renderer.factory', { label: 'good' })}
      </>
    ))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = runtime.renderRoot()
    const definition = runtime.factoryOf('renderer.factory')
    spy.mockRestore()

    expect(view.container.querySelector('[data-factory-error="renderer.factory"]')).not.toBeNull()
    expect(view.container.querySelector('[data-factory="good"]')).not.toBeNull()
    expect(reported).toHaveBeenCalledWith(
      'factory:renderer.factory', definition, expect.any(Error), { abdicated: false },
    )
    await runtime.dispose()
  })

  it('attributes a caller-selected local Component crash to its caller', async () => {
    const runtime = await SlotTestRuntime.create()
    installLocale(runtime)
    registerFactory(runtime, counterHandle)
    const reported = vi.fn()
    runtime.slots.onEntryError(reported)
    await runtime.root.declare({}, ({ renderFactorySlot }: PropsRuntime<'root'> & PropsRenderFactories) => (
      <>{renderFactorySlot('renderer.factory', { label: 'local' }, { slots: { view: CrashingView } })}</>
    ))
    const caller = runtime.slots.entries('root')[0]
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = runtime.renderRoot()
    spy.mockRestore()

    expect(view.container.querySelector('[data-factory-error="renderer.factory:view"]')).not.toBeNull()
    expect(reported).toHaveBeenCalledWith(
      'factory:renderer.factory', caller, expect.any(Error), { abdicated: false },
    )
    await runtime.dispose()
  })

  it('attributes a fallback local Component crash to its Factory definition and resets for its Session', async () => {
    const runtime = await SlotTestRuntime.create()
    await runtime.sessions.add({ id: 'broken' })
    const broken = runtime.sessions.retainFor(runtime.ctx, sid('broken'))
    runtime.slots.registerFactory({
      name: 'renderer.scoped-local-factory',
      scope: 'root',
      slots: { view: { scope: 'session' } },
    }, ({ useFactorySlot }) => {
      const View = useFactorySlot('view', SessionCrashingView)
      return <View />
    })
    const reported = vi.fn()
    runtime.slots.onEntryError(reported)
    let selectReference: ((reference: SessionReference) => void) | undefined
    await runtime.root.declare(SESSION_AREA, ({ renderFactorySlot, SessionProvider }) => {
      const [reference, select] = useState(broken)
      selectReference = select
      return (
        <SessionProvider session={reference}>
          {renderFactorySlot('renderer.scoped-local-factory', {})}
        </SessionProvider>
      )
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = runtime.renderRoot()
    const definition = runtime.factoryOf('renderer.scoped-local-factory')

    expect(view.container.querySelector('[data-factory-error="renderer.scoped-local-factory:view"]')).not.toBeNull()
    expect(reported).toHaveBeenCalledWith(
      'factory:renderer.scoped-local-factory', definition, expect.any(Error),
      { abdicated: false },
    )
    await runtime.sessions.add({ id: 'healthy' })
    const healthy = runtime.sessions.retainFor(runtime.ctx, sid('healthy'))
    await act(async () => { selectReference?.(healthy) })
    expect(view.container.textContent).toBe('healthy')
    spy.mockRestore()
    await runtime.dispose()
  })

  it('preserves caller ownership when a selected local Component renders a nested Factory', async () => {
    const runtime = await SlotTestRuntime.create()
    installLocale(runtime)
    registerFactory(runtime, counterHandle)
    runtime.slots.registerFactory({
      name: 'renderer.nested-factory', scope: 'root', slots: { view: { scope: 'root' } },
    }, NestedFactoryBody)
    const reported = vi.fn()
    runtime.slots.onEntryError(reported)
    await runtime.root.declare({}, ({ renderFactorySlot }: PropsRuntime<'root'> & PropsRenderFactories) => (
      <>{renderFactorySlot('renderer.factory', { label: 'nested' }, { slots: { view: NestedFactoryView } })}</>
    ))
    const caller = runtime.slots.entries('root')[0]
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    runtime.renderRoot()
    spy.mockRestore()

    expect(reported).toHaveBeenCalledWith(
      'factory:renderer.nested-factory', caller, expect.any(Error),
      { abdicated: false },
    )
    await runtime.dispose()
  })

  it('reports stale authorization failures while their Factory definition remains live', async () => {
    const runtime = await SlotTestRuntime.create()
    installLocale(runtime)
    registerFactory(runtime, counterHandle, () => {
      throw new StaleAuthorizationError('definition unloaded during render')
    })
    const reported = vi.fn()
    runtime.slots.onEntryError(reported)
    await runtime.root.declare({}, ({ renderFactorySlot }: PropsRuntime<'root'> & PropsRenderFactories) => (
      <>{renderFactorySlot('renderer.factory', { label: 'stale' })}</>
    ))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = runtime.renderRoot()
    spy.mockRestore()

    expect(view.container.querySelector('[data-factory-error="renderer.factory"]')).not.toBeNull()
    expect(reported).toHaveBeenCalledWith(
      'factory:renderer.factory', runtime.factoryOf('renderer.factory'), expect.any(StaleAuthorizationError),
      { abdicated: false },
    )
    await runtime.dispose()
  })

  it('retries a failed session Factory after the Session incarnation changes', async () => {
    const runtime = await SlotTestRuntime.create()
    await runtime.sessions.add({ id: 'broken' })
    const broken = runtime.sessions.retainFor(runtime.ctx, sid('broken'))
    runtime.slots.registerFactory({
      name: 'renderer.session-error-factory', scope: 'session',
    }, ({ crashIn, sessionId }) => {
      if (sessionId === crashIn) throw new Error(`crash:${sessionId}`)
      return <span>{sessionId}</span>
    })
    let selectReference: ((reference: SessionReference) => void) | undefined
    await runtime.root.declare(SESSION_AREA, ({ renderFactorySlot, SessionProvider }) => {
      const [reference, select] = useState(broken)
      selectReference = select
      return (
        <SessionProvider session={reference}>
          {renderFactorySlot('renderer.session-error-factory', { crashIn: 'broken' })}
        </SessionProvider>
      )
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = runtime.renderRoot()
    expect(view.container.querySelector('[data-factory-error="renderer.session-error-factory"]')).not.toBeNull()

    await runtime.sessions.add({ id: 'healthy' })
    const healthy = runtime.sessions.retainFor(runtime.ctx, sid('healthy'))
    await act(async () => { selectReference?.(healthy) })
    expect(view.container.textContent).toBe('healthy')
    spy.mockRestore()
    await runtime.dispose()
  })

  it('resets a failed boundary when the render position selects another Factory', async () => {
    const runtime = await SlotTestRuntime.create()
    runtime.slots.registerFactory({ name: 'renderer.error-factory', scope: 'root' }, () => {
      throw new Error('broken factory')
    })
    runtime.slots.registerFactory(
      { name: 'renderer.healthy-factory', scope: 'root' },
      () => <span>healthy factory</span>,
    )
    await runtime.root.declare({}, ({ renderFactorySlot }: PropsRuntime<'root'> & PropsRenderFactories) => {
      const [name, setName] = useState<'renderer.error-factory' | 'renderer.healthy-factory'>('renderer.error-factory')
      return (
        <>
          <button type="button" onClick={() => { setName('renderer.healthy-factory') }}>switch factory</button>
          {renderFactorySlot(name, {})}
        </>
      )
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = runtime.renderRoot()
    expect(view.container.querySelector('[data-factory-error="renderer.error-factory"]')).not.toBeNull()

    fireEvent.click(view.getByRole('button', { name: 'switch factory' }))
    expect(view.container.textContent).toContain('healthy factory')
    spy.mockRestore()
    await runtime.dispose()
  })

  it('rejects undeclared local slots, recursive rendering, duplicate props, and stale child authority', async () => {
    const unknownRuntime = await SlotTestRuntime.create()
    installLocale(unknownRuntime)
    registerFactory(unknownRuntime, counterHandle)
    await unknownRuntime.root.declare({}, ({ renderFactorySlot }: PropsRuntime<'root'> & PropsRenderFactories) => (
      <>{renderFactorySlot('renderer.factory', { label: 'A' }, {
        slots: { unknown: DefaultView } as never,
      })}</>
    ))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unknownView = unknownRuntime.renderRoot()
    expect(unknownView.container.querySelector('[data-slot-error="root"]')).not.toBeNull()
    expect(spy.mock.calls.flat().some(value => String(value).includes("local slot 'unknown' is not declared"))).toBe(true)
    spy.mockRestore()
    await unknownRuntime.dispose()

    const recursiveRuntime = await SlotTestRuntime.create()
    recursiveRuntime.slots.registerFactory({
      name: 'renderer.recursive-factory', scope: 'root',
    }, ({ renderFactorySlot }: FactoryComponentPropsOf<'renderer.recursive-factory'>) => (
      <>{renderFactorySlot('renderer.recursive-factory', {})}</>
    ))
    await recursiveRuntime.root.declare({}, ({ renderFactorySlot }: PropsRuntime<'root'> & PropsRenderFactories) => (
      <>{renderFactorySlot('renderer.recursive-factory', {})}</>
    ))
    const recursiveSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const recursiveView = recursiveRuntime.renderRoot()
    expect(recursiveView.container.querySelector('[data-factory-error="renderer.recursive-factory"]')).not.toBeNull()
    expect(recursiveSpy.mock.calls.flat().some(value => String(value).includes('recursive render of factory'))).toBe(true)
    recursiveSpy.mockRestore()
    await recursiveRuntime.dispose()

    const staleRuntime = await SlotTestRuntime.create()
    installLocale(staleRuntime)
    let retainedRender: FactoryProps['renderSlot'] | undefined
    const dispose = registerFactory(staleRuntime, counterHandle, (props) => {
      retainedRender = props.renderSlot
      return null
    })
    await staleRuntime.root.declare({}, ({ renderFactorySlot }: PropsRuntime<'root'> & PropsRenderFactories) => (
      <>{renderFactorySlot('renderer.factory', { label: 'A' })}</>
    ))
    staleRuntime.renderRoot()
    dispose()
    expect(() => retainedRender?.('renderer.factory.child', {})).toThrow(/disposed Factory/)
    await staleRuntime.dispose()

    const collisionRuntime = await SlotTestRuntime.create()
    installLocale(collisionRuntime)
    registerFactory(collisionRuntime, counterHandle)
    await collisionRuntime.root.declare({}, ({ renderFactorySlot }: PropsRuntime<'root'> & PropsRenderFactories) => (
      <>{renderFactorySlot('renderer.factory', { label: 'A', actions: 'caller' } as never)}</>
    ))
    const collisionSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => collisionRuntime.renderRoot()).toThrow(/duplicate prop 'actions'/)
    collisionSpy.mockRestore()
    await collisionRuntime.dispose()
  })
})
