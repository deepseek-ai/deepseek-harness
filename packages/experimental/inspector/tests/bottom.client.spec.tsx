// @vitest-environment jsdom
/** Bottom Inspector lifetime and shortcuts through the production slot renderer. */
import { afterEach, expect, it } from 'vitest'
import { act } from '@testing-library/react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import ShortcutsService from '@deepseek-ai/dsh-client-shortcuts/client'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import { registerInspectorPage } from '../src/client/bottom/page.tsx'
import { inspectorId } from '../src/shared/identity.ts'

const ID = 'inspector.toggle' as ShortcutCommandId
const sourceId = inspectorId<'InspectorSourceId'>('client-page', 'sourceId')
const runtimes: SlotTestRuntime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  localStorage.clear()
})

async function setup() {
  const runtime = await SlotTestRuntime.create()
  runtimes.push(runtime)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  locale.setLocale('en')
  await runtime.ctx.plugin(ShortcutsService).await()
  await expect.poll(() => runtime.ctx.shortcuts.config.getSnapshot().status).toBe('ready')
  await runtime.declare({ 'shell.bottom': { kind: 'single', scope: 'root' } })
  const plugin = { inject: ['locale', 'shortcuts', 'slots'], apply: (ctx: typeof runtime.ctx) => { registerInspectorPage(ctx, sourceId) } }
  const provider = await runtime.mount(plugin)
  const body = runtime.renderSlot('shell.bottom', {})
  return { runtime, locale, provider, body, plugin }
}

function press(target: EventTarget = window, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', {
    key: '>', code: 'Period', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true, composed: true, ...options,
  })
  act(() => { target.dispatchEvent(event) })
  return event
}

it('opens on Mod+Shift+Period without a Session or Sidebar and retains the iframe while collapsed', async () => {
  const { runtime, body } = await setup()
  expect(body.container.querySelector('iframe')).toBeNull()
  expect(runtime.ctx.shortcuts.catalog.getSnapshot().find(row => row.id === ID)?.binding)
    .toEqual({ code: 'Period', modifiers: ['control', 'shift'] })
  expect(press(window, { ctrlKey: false }).defaultPrevented).toBe(false)
  expect(body.container.querySelector('iframe')).toBeNull()
  expect(press().defaultPrevented).toBe(true)
  const frame = body.view.getByTitle('NodeJS Inspector')
  expect(frame.getAttribute('src')).toBe('inspector/devtools/devtools_app.html?disableLocaleInfoBar=true&clientSourceId=client-page')
  expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
  expect(frame.getAttribute('name')).toBe('dsh-nodejs-inspector')
  const close = body.view.getByRole('button', { name: 'Collapse' })
  expect(close.textContent).toBe('')
  expect(close.querySelector('svg')).not.toBeNull()
  expect(press(window, { repeat: true }).defaultPrevented).toBe(true)
  expect(body.container.querySelector('section')?.hidden).toBe(false)
  press()
  expect(body.container.querySelector('section')?.hidden).toBe(true)
  press()
  expect(body.view.getByTitle('NodeJS Inspector')).toBe(frame)
  expect(body.container.querySelector('section')?.hidden).toBe(false)
})

it('resizes with the owned pointer, bounds the height, and retains it across collapse', async () => {
  const { body } = await setup()
  press()
  const panel = body.container.querySelector('section')!
  const frame = body.view.getByTitle('NodeJS Inspector')
  const divider = body.view.getByRole('separator', { name: 'Resize NodeJS Inspector panel' })
  let captured: number | undefined
  Object.assign(divider, {
    setPointerCapture: (id: number) => { captured = id },
    hasPointerCapture: (id: number) => captured === id,
    releasePointerCapture: () => { captured = undefined },
  })
  const pointer = (type: string, clientY: number, pointerId = 1, button = 0): void => {
    act(() => { divider.dispatchEvent(new PointerEvent(type, { clientY, pointerId, button, bubbles: true })) })
  }
  const height = () => parseFloat(panel.style.getPropertyValue('--inspector-height'))
  pointer('pointerdown', 500, 1, 2)
  pointer('pointermove', 400)
  expect(height()).toBe(45)
  pointer('pointerdown', 500)
  pointer('pointerdown', 200, 2)
  pointer('pointermove', 0, 2)
  pointer('pointerup', 0, 2)
  expect(height()).toBe(45)
  pointer('pointermove', 500 - window.innerHeight / 10)
  expect(height()).toBeCloseTo(55)
  pointer('pointerup', 500 - window.innerHeight / 5)
  expect(height()).toBeCloseTo(65)
  expect(captured).toBeUndefined()
  pointer('pointermove', 0)
  expect(height()).toBeCloseTo(65)
  pointer('pointerdown', 500)
  pointer('pointermove', -window.innerHeight)
  expect(height()).toBe(80)
  pointer('pointermove', window.innerHeight * 2)
  expect(height()).toBe(20)
  pointer('pointercancel', 0)
  expect(captured).toBeUndefined()
  pointer('pointermove', 0)
  expect(height()).toBe(20)
  pointer('pointerdown', 500)
  pointer('lostpointercapture', 500)
  pointer('pointermove', 0)
  expect(height()).toBe(20)
  press()
  press()
  expect(height()).toBe(20)
  expect(body.view.getByTitle('NodeJS Inspector')).toBe(frame)
})

it('resizes the horizontal divider with arrow keys and Home or End', async () => {
  const { body } = await setup()
  press()
  const divider = body.view.getByRole('separator')
  expect(divider.getAttribute('aria-orientation')).toBe('horizontal')
  expect(divider.getAttribute('aria-controls')).toBe(body.container.querySelector('section')!.id)
  for (const [key, value] of [['ArrowUp', '50'], ['ArrowDown', '45'], ['Home', '20'], ['End', '80']] as const) {
    expect(press(divider, { key, code: key, ctrlKey: false, shiftKey: false }).defaultPrevented).toBe(true)
    expect(divider.getAttribute('aria-valuenow')).toBe(value)
  }
  expect(press(divider, { key: 'a', code: 'KeyA', ctrlKey: false, shiftKey: false }).defaultPrevented).toBe(false)
  expect(divider.getAttribute('aria-valuenow')).toBe('80')
})

it('routes frame input through the effective binding and restores opener focus', async () => {
  const { runtime, body } = await setup()
  const opener = document.createElement('input')
  document.body.append(opener)
  try {
    opener.focus()
    press(opener)
    const frame = body.view.getByTitle<HTMLIFrameElement>('NodeJS Inspector')
    const document = frame.contentDocument!
    frame.focus()
    expect(press(document).defaultPrevented).toBe(true)
    expect(body.container.querySelector('section')?.hidden).toBe(true)
    expect(opener.ownerDocument.activeElement).toBe(opener)
    press(opener)
    press(document, { isComposing: true })
    expect(body.container.querySelector('section')?.hidden).toBe(false)
    await act(async () => {
      const { revision } = runtime.ctx.shortcuts.config.getSnapshot()
      await runtime.ctx.shortcuts.edit({ type: 'set', id: ID, binding: { code: 'Comma', modifiers: ['primary', 'shift'] } }, revision)
    })
    expect(press(document).defaultPrevented).toBe(false)
    expect(body.container.querySelector('section')?.hidden).toBe(false)
    expect(press(document, { code: 'Comma', key: '<', ctrlKey: true }).defaultPrevented).toBe(true)
    expect(body.container.querySelector('section')?.hidden).toBe(true)
  } finally { opener.remove() }
})

it('keeps modal arbitration and updates locale without replacing the iframe', async () => {
  const { locale, body } = await setup()
  const modal = document.createElement('div')
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-modal', 'true')
  document.body.append(modal)
  try {
    press()
    expect(body.container.querySelector('iframe')).toBeNull()
  } finally { modal.remove() }
  press()
  const frame = body.view.getByTitle('NodeJS Inspector')
  act(() => { locale.setLocale('zh') })
  expect(body.view.getByTitle('NodeJS 诊断')).toBe(frame)
  act(() => { body.view.getByRole('button', { name: '收起' }).click() })
  expect(body.container.querySelector('section')?.hidden).toBe(true)
})

it('removes the command and frame on unload and starts a fresh closed panel on reload', async () => {
  const { runtime, locale, provider, body, plugin } = await setup()
  press()
  const frame = body.view.getByTitle('NodeJS Inspector')
  await provider.dispose()
  expect(runtime.ctx.shortcuts.catalog.getSnapshot().find(row => row.id === ID)).toBeUndefined()
  expect(frame.isConnected).toBe(false)
  expect(locale.bind('inspectorPanel')('frameTitle')).toBe('frameTitle')
  await runtime.mount(plugin)
  expect(body.container.querySelector('iframe')).toBeNull()
  press()
  expect(body.view.getByTitle('NodeJS Inspector')).not.toBe(frame)
})
