/** Model-facing guidance lists the object API with platform availability and input constraints. */
import { expect, it } from 'vitest'
import type { CuaApi, CuaApp, CuaSurface, CuaWindow } from '@deepseek-ai/dsh-cua/api'
import { COMMON_GUIDANCE, withHeldInputGuidance, withSystemInputGuidance } from '@deepseek-ai/dsh-cua/guidance'
import { GUIDANCE, PLATFORM_GUIDANCE, PROGRAM_GUIDANCE } from '../src/guidance.ts'

const apiNames: Array<keyof CuaApi> = ['getCapabilities', 'listApps', 'findApps', 'getState', 'getApp']
const accessibilityNames: Array<Exclude<keyof CuaSurface, 'sendKeyEvent'>> = [
  'getAccessibilityTree', 'listActions', 'getActionSchema', 'invoke', 'performAction', 'setValue', 'selectText',
]
const appNames: Array<keyof CuaApp> = ['appHandle', 'launch', 'activate', 'getWindows', 'getWindow']
const windowNames: Array<keyof CuaWindow> = ['windowId', 'getScreenshot', 'mouseMove', 'toggleMouse', 'click', 'scroll', 'drag']
const getActionSchemaLine = '- getActionSchema(action: string) -> JSON Schema — query the parameter schema for an action.'

it('keeps file-tool instructions in PTC and limits the program guidance to available bindings', () => {
  for (const name of ['tools.write', 'tools.grep', 'tools.read']) {
    expect(GUIDANCE).toContain(name)
    expect(PROGRAM_GUIDANCE).not.toContain(name)
  }
  expect(PROGRAM_GUIDANCE).toContain('node:fs/promises')
  expect(PROGRAM_GUIDANCE).toContain('session’s file tools')
})

it('places observation chapters before simulated input with screenshots in their own chapter', () => {
  for (const catalog of [COMMON_GUIDANCE, GUIDANCE, PROGRAM_GUIDANCE]) {
    expect(catalog.match(/^## .+$/gm)).toEqual(['## Accessibility tree', '## Screenshots', '## Simulated mouse', '## Simulated keyboard'])
    const screenshots = catalog.slice(catalog.indexOf('## Screenshots'), catalog.indexOf('## Simulated mouse'))
    expect(screenshots).toContain('- getScreenshot() -> Image')
    expect(catalog.slice(catalog.indexOf('## Simulated mouse'))).not.toContain('- getScreenshot(')
  }
})

it('prefixes concise platform guidance before the shared catalog', () => {
  expect(GUIDANCE.startsWith(`${PLATFORM_GUIDANCE}\n\nUse cua`)).toBe(true)
  expect(PLATFORM_GUIDANCE).not.toContain('##')
})

it.each([GUIDANCE, PROGRAM_GUIDANCE])('explains when macOS mouse input needs a system-pointer prompt', (catalog) => {
  const instructions = withSystemInputGuidance(catalog)
  expect(catalog.split('- mouseMove(')[0]).toContain('Leave useSystemInput unset')
  expect(instructions).toContain('When approval is enabled, the first explicit system input requests permission;')
  expect(instructions).toContain('Omitting the option or passing false uses the provider default.')
  expect(instructions).toContain("direction: 'down' | 'up', options?: { useSystemInput?: boolean }")
  expect(instructions).toContain('Pass useSystemInput: true on each down')
  const drag = instructions.split('\n').find(line => line.startsWith('- drag('))
  expect(drag).toContain('useSystemInput?: boolean')
  expect(drag).toContain('Omitting useSystemInput or passing false directs the drag to the window without asking for mouse control.')
  expect(COMMON_GUIDANCE).not.toContain('window-directed drag')
})

it('states the macOS accessibility, keyboard, and mouse levels', () => {
  expect(PLATFORM_GUIDANCE).toContain('accessibility tree operations are available at app or window level')
  expect(PLATFORM_GUIDANCE).toContain('Simulated keyboard input is available at app level')
  expect(PLATFORM_GUIDANCE).toContain('Simulated mouse input is available at window level')
  const pressKey = GUIDANCE.split('\n').find(line => line.startsWith('- pressKey('))
  expect(GUIDANCE).toContain("sendKeyEvent(key: string, direction: 'down' | 'up')")
  expect(COMMON_GUIDANCE).not.toContain('sendKeyEvent and toggleMouse remain held across programs and turns')
  expect(withHeldInputGuidance(COMMON_GUIDANCE)).toContain('sendKeyEvent and toggleMouse remain held across programs and turns')
  expect(withHeldInputGuidance(COMMON_GUIDANCE)).toContain('a system reminder lists any remaining keys and mouse buttons')
  const sharedKeyEvent = COMMON_GUIDANCE.split('\n').find(line => line.startsWith('- sendKeyEvent('))
  expect(sharedKeyEvent).toBeDefined()
  expect(GUIDANCE.split('\n').find(line => line.startsWith('- sendKeyEvent('))).toContain(sharedKeyEvent)
  expect(pressKey).toContain(COMMON_GUIDANCE.split('\n').find(line => line.startsWith('- pressKey(')))
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

it('documents explicit mouse-button events immediately after mouseMove', () => {
  const lines = COMMON_GUIDANCE.split('\n')
  const index = lines.findIndex(line => line.startsWith('- toggleMouse('))
  expect(lines[index - 1]).toMatch(/^- mouseMove\(/)
  expect(lines[index]).toBe("- toggleMouse(mouseButton: 'left' | 'right' | 'middle', direction: 'down' | 'up') -> ActionResult — press or release the specified mouse button at the current pointer position without moving it. No coordinates are accepted. Send 'up' to release a held button immediately.")
  expect(index).toBeGreaterThan(lines.indexOf('## Simulated mouse'))
  expect(index).toBeLessThan(lines.indexOf('## Simulated keyboard'))
})

it.each([GUIDANCE, PROGRAM_GUIDANCE])('documents the default window release and the optional system hold', (catalog) => {
  const entry = catalog.split('\n').find(line => line.startsWith('- toggleMouse('))
  expect(entry).toContain('By default the window receives the events, even a release outside it, and the system button stays up.')
  expect(entry).toContain('Pass useSystemInput: true on each down to hold multiple system buttons in the same window.')
})

it('enumerates every public method once in its catalog entry', () => {
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
  expect(signatures).toHaveLength(28)
  expect(new Set(signatures.map(signature => signature.slice(signature.indexOf('.') + 1, -1))).size).toBe(27)
  expect(COMMON_GUIDANCE).toContain('app.appHandle')
  expect(COMMON_GUIDANCE).toContain('window.windowId')
})

it('documents getActionSchema beside listActions with only an action argument', () => {
  const lines = COMMON_GUIDANCE.split('\n')
  const listActions = lines.findIndex(line => line.startsWith('- listActions('))
  expect(lines[listActions + 1]).toBe(getActionSchemaLine)
  expect(getActionSchemaLine.split(' — ')[0]).toBe('- getActionSchema(action: string) -> JSON Schema')
  expect(COMMON_GUIDANCE).not.toMatch(/\bAX\b/)
})

it.each([GUIDANCE, PROGRAM_GUIDANCE])('keeps action schema guidance focused on its purpose', (catalog) => {
  const entry = catalog.split('\n').find(line => line.startsWith('- getActionSchema('))
  expect(entry).toBe(getActionSchemaLine)
  expect(COMMON_GUIDANCE).not.toContain('Role.Attribute.Set')
})

it('documents option fields and return fields', () => {
  for (const token of ['includeMenus', 'details', 'maxElements', 'maxDepth', 'relative', 'mouseButton', 'clickCount', 'holdMs', 'modifiers', 'format', 'prefix', 'suffix', 'selectionType']) expect(COMMON_GUIDANCE).toContain(token)
  for (const token of ['dispatched', 'foregroundChanged', 'hoverRoute', 'systemPointerMoved', 'path', 'width', 'height', 'windowId']) expect(COMMON_GUIDANCE).toContain(token)
})

it('inlines capability, window, restoration, and mouse-move return records', () => {
  const lines = COMMON_GUIDANCE.split('\n')
  for (const name of ['cua.getCapabilities', 'cua.getState', 'app.getWindows', 'app.show', 'window.show', 'mouseMove']) {
    expect(lines.find(line => line.startsWith(`- ${name}(`))).toMatch(/ -> \(?\{ /)
  }
  expect(COMMON_GUIDANCE).toContain("{ platform: string, permissions: { accessibility: boolean, screenRecording: boolean }, appLevelAccessibility: boolean, systemInput: boolean, keyboard: ('app' | 'window')[], sessionLocked: boolean | null, methods: string[], coordinateSpace: 'screenshot-pixels', browser: false }")
  expect(COMMON_GUIDANCE).toContain('getScreenshot() -> Image')
  expect(COMMON_GUIDANCE).toContain('bounds: { x: number, y: number, width: number, height: number }, isOnScreen: boolean, onCurrentSpace: boolean | null')
})

it('reuses CuaAppInfo for running and discoverable application rows', () => {
  const lines = COMMON_GUIDANCE.split('\n')
  const entry = (name: string) => lines.find(line => line.startsWith(`- ${name}(`))
  const definition = 'CuaAppInfo = { id: string, displayName: string, identity: string | null, isRunning: boolean, pid?: number }'
  expect(COMMON_GUIDANCE).toContain(`${definition}. Pass id unchanged to cua.getApp.`)
  expect(entry('cua.listApps')).toBe('- cua.listApps() -> CuaAppInfo[] — list running applications exposed by the provider.')
  expect(entry('cua.findApps')).toContain('- cua.findApps(query: string | null) -> CuaAppInfo[] — query is a partial-match search string for discoverable applications, including stopped apps.')
  expect(entry('cua.findApps')).toContain('Pass an empty string or null to list all discoverable apps without a match-count limit.')
  expect(entry('cua.getState')).toBe('- cua.getState() -> { apps: CuaAppInfo[], browsers: [] } — return the running application list from listApps(), together with an empty browser list.')
  expect(GUIDANCE).toContain('Each row represents one running process.')
  expect(GUIDANCE).toContain('Each row represents an installation.')
  for (const catalog of [GUIDANCE, PROGRAM_GUIDANCE]) {
    expect(catalog).toContain('On macOS, identity comes from the canonical application bundle path. For installations sharing an id, pass their non-null identity unchanged to cua.getApp. To select a specific running instance, pass String(pid); instances of the same installation can share both id and identity. Running records include a pid; stopped records omit it.')
  }
})

it('names accessibility operations without AX abbreviations in shared guidance', () => {
  expect(COMMON_GUIDANCE).toContain('return without reading the accessibility tree or requesting activation')
  expect(COMMON_GUIDANCE).toContain('do not read or replace the current accessibility snapshot')
  expect(COMMON_GUIDANCE).toContain('based on the current accessibility observation or screenshot')
  expect(COMMON_GUIDANCE).not.toMatch(/\bAX\b/)
})

it('documents shared types while leaving Modifier members platform-defined', () => {
  const signatures = COMMON_GUIDANCE.split('\n').filter(line => line.startsWith('- ')).map(line => line.split(' — ')[0]).join('\n')
  const names = signatures.replace(/'[^']*'/g, '').match(/\b[A-Z][A-Za-z0-9_]*\b/g) ?? []
  expect([...new Set(names)].sort()).toEqual(['ActionResult', 'App', 'CuaAppInfo', 'Image', 'JSON', 'JsonValue', 'Modifier', 'Schema', 'Window'])
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
  expect(COMMON_GUIDANCE).toContain('## Screenshots\nUse an explicit window for screenshots.')
  expect(COMMON_GUIDANCE).toContain('## Simulated mouse\nUse an explicit window for pointer input.')
  for (const heading of ['Accessibility tree', 'Simulated keyboard']) {
    expect(COMMON_GUIDANCE).toContain(`## ${heading}\nAvailable at app or window level depending on the platform.`)
  }
  expect(GUIDANCE).not.toMatch(/\bsurface\b/)
  const groups = COMMON_GUIDANCE.slice(COMMON_GUIDANCE.indexOf('## Accessibility tree'))
  expect(groups).not.toMatch(/^- (?:surface|window|app)\./m)
  expect(COMMON_GUIDANCE).toContain('target: string | [number, number]')
  expect(COMMON_GUIDANCE).toContain('from: [number, number]')
})

it('guides complex input combinations through platform-supported primitive operations', () => {
  const advice = 'click, drag, and pressKey are convenience operations; sendKeyEvent, mouseMove, and toggleMouse are primitive operations. For complex action combinations, decompose convenience operations into sequences of primitive operations supported by the current platform.'
  for (const catalog of [COMMON_GUIDANCE, GUIDANCE, PROGRAM_GUIDANCE]) {
    expect(catalog).toContain(advice)
    expect(catalog.indexOf(advice)).toBeGreaterThan(catalog.indexOf('- sendKeyEvent('))
  }
})

it('keeps consent, lock, observation, and no-replay rules', () => {
  expect(COMMON_GUIDANCE).toContain('consent')
  expect(COMMON_GUIDANCE).toContain('SESSION_LOCKED')
  expect(COMMON_GUIDANCE).toContain('Never replay uncertain input')
  expect(COMMON_GUIDANCE).toContain('Read fresh state after actions')
  expect(COMMON_GUIDANCE).toMatch(/element ids are opaque strings/i)
})

it('omits raw protocol details from operation guidance', () => {
  for (const catalog of [COMMON_GUIDANCE, GUIDANCE, PROGRAM_GUIDANCE]) {
    expect(catalog).not.toContain('Raw tools use { method, params }')
    expect(catalog).not.toContain('cua.getState maps to findApps')
    expect(catalog).not.toContain('snapshotId')
  }
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

it('omits stale names and unrelated operations', () => {
  for (const stale of ['getAXState', 'emit', 'disableDiffing', 'performSecondaryAction', 'hover(', 'keyChord', 'window.typeText', 'window.pressKey', 'elementIndex', 'verified: false', 'browser tabs']) expect(GUIDANCE).not.toContain(stale)
})

it('adds system-input selection to exactly the six supported methods', () => {
  const catalog = withSystemInputGuidance(PROGRAM_GUIDANCE)
  const selected = catalog.split('\n').filter(line => line.startsWith('- ') && line.split(' -> ')[0]?.includes('useSystemInput'))
    .map(line => line.slice(2, line.indexOf('(')))
  expect(selected).toEqual(['mouseMove', 'toggleMouse', 'click', 'drag', 'pressKey', 'sendKeyEvent'])
})

it('rejects malformed provider input signatures instead of truncating their text', () => {
  expect(() => withSystemInputGuidance('- click(target)')).toThrow('missing the result separator for click')
})
