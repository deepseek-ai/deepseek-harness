/** Model-facing guidance enumerates the full available object API without unavailable operations. */
import { expect, it } from 'vitest'
import type { CuaApi, CuaApp, CuaSurface, CuaWindow } from '@deepseek-ai/dsh-cua/api'
import { COMMON_GUIDANCE, withSystemPointerGuidance } from '@deepseek-ai/dsh-cua/guidance'
import { GUIDANCE, PLATFORM_GUIDANCE, PROGRAM_GUIDANCE } from '../src/guidance.ts'

const apiNames: Array<keyof CuaApi> = ['getCapabilities', 'listApps', 'findApps', 'getState', 'getApp']
const accessibilityNames: Array<Exclude<keyof CuaSurface, 'sendKeyEvent'>> = [
  'getAccessibilityTree', 'listActions', 'invoke', 'performAction', 'setValue', 'selectText',
]
const appNames: Array<keyof CuaApp> = ['appHandle', 'activate', 'getWindows', 'getWindow']
const windowNames: Array<keyof CuaWindow> = ['windowId', 'getScreenshot', 'mouseMove', 'click', 'scroll', 'drag']

it('keeps file-tool instructions in PTC and limits the program guidance to available bindings', () => {
  for (const name of ['tools.write', 'tools.grep', 'tools.read']) {
    expect(GUIDANCE).toContain(name)
    expect(PROGRAM_GUIDANCE).not.toContain(name)
  }
  expect(PROGRAM_GUIDANCE).toContain('node:fs/promises')
  expect(PROGRAM_GUIDANCE).toContain('session’s file tools')
})

it('keeps exactly three ordered operation headings', () => {
  const heads = COMMON_GUIDANCE.match(/^## .+$/gm)
  expect(heads).toEqual(['## Accessibility tree', '## Simulated mouse', '## Simulated keyboard'])
  expect(COMMON_GUIDANCE.indexOf('## Accessibility tree')).toBeLessThan(COMMON_GUIDANCE.indexOf('## Simulated mouse'))
  expect(COMMON_GUIDANCE.indexOf('## Simulated mouse')).toBeLessThan(COMMON_GUIDANCE.indexOf('## Simulated keyboard'))
})

it('prefixes concise platform guidance before the shared catalog', () => {
  expect(GUIDANCE.startsWith(`${PLATFORM_GUIDANCE}\n\nUse cua`)).toBe(true)
  expect(PLATFORM_GUIDANCE).not.toContain('##')
})

it.each([GUIDANCE, PROGRAM_GUIDANCE])('explains when macOS mouse input needs a system-pointer prompt', (catalog) => {
  const instructions = withSystemPointerGuidance(catalog)
  expect(catalog.split('- mouseMove(')[0]).toContain('Leave useSystemPointer unset')
  expect(instructions).toContain('Prefer an advertised accessibility action, a click on a visible control, or browser tools when possible.')
  expect(instructions).toContain('The question interrupts the user.')
  expect(instructions).toContain('Omitting the option or passing false uses the default hover route without prompting.')
  const drag = catalog.split('\n').find(line => line.startsWith('- drag('))
  expect(drag).toContain('useSystemPointer?: boolean')
  expect(drag).toContain('Omitting useSystemPointer or passing false directs the drag to the window without asking for mouse control.')
  expect(COMMON_GUIDANCE).not.toContain('window-directed drag')
})

it('states the macOS accessibility, keyboard, and mouse levels', () => {
  expect(PLATFORM_GUIDANCE).toContain('accessibility tree operations are available at app or window level')
  expect(PLATFORM_GUIDANCE).toContain('Simulated keyboard input is available at app level')
  expect(PLATFORM_GUIDANCE).toContain('Simulated mouse input is available at window level')
  const pressKey = GUIDANCE.split('\n').find(line => line.startsWith('- pressKey('))
  expect(GUIDANCE).toContain("sendKeyEvent(key: string, direction: 'down' | 'up')")
  expect(GUIDANCE).toContain('returns, throws, or the user pauses')
  const sharedKeyEvent = COMMON_GUIDANCE.split('\n').find(line => line.startsWith('- sendKeyEvent('))
  expect(sharedKeyEvent).toBeDefined()
  expect(GUIDANCE.split('\n').find(line => line.startsWith('- sendKeyEvent('))).toContain(sharedKeyEvent)
  expect(pressKey).toBe(COMMON_GUIDANCE.split('\n').find(line => line.startsWith('- pressKey(')))
  expect(GUIDANCE).toContain('W down, D down, D up, W up')
  const hover = GUIDANCE.split('\n').find(line => line.startsWith('- mouseMove('))
  for (const term of ['AXShowAlternateUI', 'AXShowDefaultUI', 'HOVER_UNAVAILABLE']) expect(hover).toContain(term)
  const click = GUIDANCE.split('\n').find(line => line.startsWith('- click('))
  expect(click).toContain('await app.getWindow(windowId), then call win.click(target)')
  expect(click).toContain('use app.invoke(id)')
  for (const step of ['call app.activate() first', 'outside the window', 'screenshot pixels', 'before typing or retrying']) expect(click).toContain(step)
  for (const platformDetail of ['macOS', 'AXShowAlternateUI', 'AXRaise', 'HOVER_UNAVAILABLE', 'mouse-down']) {
    expect(COMMON_GUIDANCE).not.toContain(platformDetail)
  }
})

it('enumerates every available method once in its catalog entry', () => {
  const signatures = [
    ...apiNames.map(name => `cua.${name}(`),
    ...appNames.filter(name => name !== 'appHandle').map(name => `app.${name}(`),
    'app.show(', 'window.show(',
    ...accessibilityNames.map(name => `${name}(`),
    ...windowNames.filter(name => name !== 'windowId').map(name => `${name}(`),
    ...['typeText', 'paste', 'pressKey', 'sendKeyEvent'].map(name => `${name}(`),
  ]
  for (const catalog of [COMMON_GUIDANCE, GUIDANCE, PROGRAM_GUIDANCE]) {
    for (const signature of signatures) expect(catalog.split('\n').filter(line => line.startsWith(`- ${signature}`))).toHaveLength(1)
  }
  expect(signatures).toHaveLength(25)
  expect(new Set(signatures.map(signature => signature.slice(signature.indexOf('.') + 1, -1))).size).toBe(24)
  expect(COMMON_GUIDANCE).toContain('app.appHandle')
  expect(COMMON_GUIDANCE).toContain('window.windowId')
})

it('documents option fields and return fields', () => {
  for (const token of ['includeMenus', 'details', 'maxElements', 'maxDepth', 'relative', 'mouseButton', 'clickCount', 'holdMs', 'modifiers', 'format', 'prefix', 'suffix', 'selectionType']) expect(COMMON_GUIDANCE).toContain(token)
  for (const token of ['dispatched', 'foregroundChanged', 'hoverRoute', 'systemPointerMoved', 'path', 'width', 'height', 'windowId']) expect(COMMON_GUIDANCE).toContain(token)
})

it('inlines discovery, restoration, and mouse-move return records', () => {
  const lines = COMMON_GUIDANCE.split('\n')
  for (const name of ['cua.getCapabilities', 'cua.listApps', 'cua.findApps', 'cua.getState', 'app.getWindows', 'app.show', 'window.show', 'mouseMove']) {
    expect(lines.find(line => line.startsWith(`- ${name}(`))).toMatch(/ -> \(?\{ /)
  }
  expect(COMMON_GUIDANCE).toContain("{ platform: string, permissions: { accessibility: boolean, screenRecording: boolean }, appLevelAccessibility: boolean, systemPointer: boolean, keyboard: ('app' | 'window')[], sessionLocked: boolean | null, methods: string[], coordinateSpace: 'screenshot-pixels', browser: false }")
  expect(COMMON_GUIDANCE).toContain('{ id: string, displayName: string, isRunning: boolean, pid?: number }[]')
  expect(COMMON_GUIDANCE).toContain('{ id: string, displayName: string, path: string, isRunning: boolean, pid?: number }[]')
  expect(COMMON_GUIDANCE).toContain('getScreenshot() -> Image')
  expect(COMMON_GUIDANCE).toContain('bounds: { x: number, y: number, width: number, height: number }, isOnScreen: boolean, onCurrentSpace: boolean | null')
})

it('documents shared types while leaving Modifier members platform-defined', () => {
  const signatures = COMMON_GUIDANCE.split('\n').filter(line => line.startsWith('- ')).map(line => line.split(' — ')[0]).join('\n')
  const names = signatures.replace(/'[^']*'/g, '').match(/\b[A-Z][A-Za-z0-9_]*\b/g) ?? []
  expect([...new Set(names)].sort()).toEqual(['ActionResult', 'App', 'Image', 'JsonValue', 'Modifier', 'Window'])
  expect(COMMON_GUIDANCE).toContain('ActionResult = { dispatched: boolean, foregroundChanged?: boolean | null }')
  expect(COMMON_GUIDANCE).toContain('JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }')
  expect(COMMON_GUIDANCE).toContain('App is the application object with readonly app.appHandle: string (opaque) and the methods listed below for app level')
  expect(COMMON_GUIDANCE).toContain('Window is the window object with readonly window.windowId: string and the methods listed below for window level')
  expect(COMMON_GUIDANCE).toContain('Signatures show resolved return values after await')
})

it('references Modifier without defining its members in shared guidance', () => {
  const lines = COMMON_GUIDANCE.split('\n')
  for (const name of ['click', 'drag', 'pressKey']) {
    const entry = lines.find(line => line.startsWith(`- ${name}(`))
    expect(entry).toContain('modifiers?: Modifier[]')
    expect(entry).not.toContain('members of Modifier')
  }
  expect(PLATFORM_GUIDANCE).toContain('pressKey, click, and drag accept command, control (or ctrl), option (or alt), shift, and fn. pressKey also accepts cmd for command.')
  expect(COMMON_GUIDANCE).toContain('\n\nSupported modifier names depend on the platform and the operation; see the platform guidance.\n\n')
  expect(COMMON_GUIDANCE).not.toMatch(/(?:type|enum) Modifier\b|Modifier\s*=/)
  expect(COMMON_GUIDANCE).not.toContain('Supported modifiers:')
  expect(COMMON_GUIDANCE).toContain('Key names are platform-defined strings')
})

it('states platform-dependent levels without qualifying grouped method names', () => {
  expect(COMMON_GUIDANCE).toContain('## Simulated mouse\nUse an explicit window for screenshots and pointer input.')
  for (const heading of ['Accessibility tree', 'Simulated keyboard']) {
    expect(COMMON_GUIDANCE).toContain(`## ${heading}\nAvailable at app or window level depending on the platform.`)
  }
  expect(GUIDANCE).not.toMatch(/\bsurface\b/)
  const groups = COMMON_GUIDANCE.slice(COMMON_GUIDANCE.indexOf('## Accessibility tree'))
  expect(groups).not.toMatch(/^- (?:surface|window|app)\./m)
  expect(COMMON_GUIDANCE).toContain('target: string | [number, number]')
  expect(COMMON_GUIDANCE).toContain('from: [number, number]')
})

it('keeps consent, lock, observation, and no-replay rules', () => {
  expect(COMMON_GUIDANCE).toContain('consent')
  expect(COMMON_GUIDANCE).toContain('SESSION_LOCKED')
  expect(COMMON_GUIDANCE).toContain('Never replay uncertain input')
  expect(COMMON_GUIDANCE).toContain('Read fresh state after actions')
  expect(COMMON_GUIDANCE).toMatch(/element ids are opaque strings/i)
  expect(COMMON_GUIDANCE).toContain('snapshotId')
})

it('prioritizes reported API availability over instruction text in the prologue', () => {
  const prologue = COMMON_GUIDANCE.split('\n\n')[0]
  expect(prologue).toContain('Always use cua.getCapabilities() to confirm whether a specific API is available on the current platform; its reported capabilities take precedence over availability statements in these instructions.')
})

it('documents explicit inspection and separate key arguments', () => {
  expect(COMMON_GUIDANCE).toContain('Call inspect(...values) to display selected observation results.')
  expect(COMMON_GUIDANCE).toContain('do not pack them into a chord string')
  expect(COMMON_GUIDANCE).toContain('perform a left-button double-click')
})

it('omits stale names and unavailable platform operations', () => {
  for (const stale of ['getAXState', 'emit', 'disableDiffing', 'performSecondaryAction', 'hover(', 'keyChord', 'window.typeText', 'window.pressKey', 'elementIndex', 'verified: false', 'browser tabs', 'not implemented']) expect(GUIDANCE).not.toContain(stale)
})
