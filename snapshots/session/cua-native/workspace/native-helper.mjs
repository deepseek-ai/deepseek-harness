#!/usr/bin/env node
/** Deterministic shared native substitute; this fixture never reads or controls the desktop. */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const argument = name => args[args.indexOf(name) + 1]
const runtimeKey = argument('--runtime-key')
const runtimeDirectory = argument('--runtime-directory')
if (!runtimeKey || !runtimeDirectory) throw new Error('Shared fixture needs its runtime identity and directory')
const socketPath = join(runtimeDirectory, `${runtimeKey}.sock`)

if (args.includes('--ensure-shared')) {
  const socket = createConnection(join(runtimeDirectory, `${runtimeKey}.fixture.sock`))
  const timer = setTimeout(() => socket.destroy(new Error('Fixture host startup timed out')), Number(argument('--startup-timeout-ms')))
  socket.once('error', error => { process.stderr.write(error.message); process.exitCode = 1 })
  socket.once('connect', () => socket.write(argument('--startup-timeout-ms') + '\n'))
  const input = createInterface({ input: socket })
  input.once('line', line => {
    clearTimeout(timer)
    if (line !== 'ready') { process.stderr.write(line); process.exitCode = 1 }
    else process.stdout.write(JSON.stringify({ type: 'ready', runtimeKey }) + '\n')
    socket.end()
  })
  socket.once('close', () => { clearTimeout(timer) })
} else {
  serve()
}

function serve() {
  mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 })
  const observe = existsSync(new URL('./observe-helper', import.meta.url))
  const record = (event, data = {}) => {
    if (observe) appendFileSync(new URL('./helper-events.jsonl', import.meta.url), JSON.stringify({ event, pid: process.pid, ...data }) + '\n')
  }
  const instanceId = randomUUID()
  const sockets = new Set()
  const application = { count: 0, value: '', visualCount: 0, hovering: false, frontPid: 42, frontWindowId: 99 }
  const captureBroker = { pendingCapture: false }
  let started = false
  let hadClient = false
  let connection = 0
  const startupDeadline = setTimeout(() => process.exit(1), Number(argument('--startup-timeout-ms')))
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket)
    let connected = false
    const connectionId = ++connection
    const input = createInterface({ input: socket })
    const scopedRecord = (event, data = {}) => record(event, { connection: connectionId, ...data })
    const call = createApplicationState(socket, scopedRecord, application, captureBroker, connectionId)
    input.on('line', line => {
      const request = JSON.parse(line)
      if (!connected) {
        if (request.type !== 'hello' || request.protocol !== 1 || request.runtimeKey !== runtimeKey) {
          socket.destroy()
          return
        }
        connected = true
        hadClient = true
        clearTimeout(startupDeadline)
        scopedRecord('connect')
        socket.write(JSON.stringify({ type: 'ready', protocol: 1, runtimeKey, pid: process.pid, instanceId }) + '\n')
        return
      }
      if (request.type === 'cancel') {
        if (typeof request.id !== 'string' || Object.keys(request).length !== 2) socket.destroy()
        return
      }
      let response
      try {
        const result = call(request.id, request.method, request.params)
        if (result === undefined) return
        response = { id: request.id, result }
      } catch (error) {
        response = { id: request.id, error: { code: error.code ?? 'FIXTURE_ERROR', message: error.message } }
      }
      socket.write(JSON.stringify(response) + '\n')
    })
    const release = () => {
      if (!sockets.delete(socket)) return
      if (connected) scopedRecord('disconnect')
      if (sockets.size === 0 && hadClient) process.exit(0)
      socket.end()
    }
    socket.once('end', release)
    socket.once('close', release)
    socket.on('error', () => socket.destroy())
  })
  server.once('error', error => {
    if (error.code !== 'EADDRINUSE') process.exit(1)
    process.send({ ready: true }, () => process.exit(0))
  })
  server.listen({ path: socketPath }, () => {
    started = true
    record('start')
    process.send?.({ ready: true })
  })
  process.once('SIGTERM', () => process.exit(0))
  process.once('exit', () => {
    if (!started) return
    record('exit')
    try { unlinkSync(socketPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
  })
}

function createApplicationState(socket, record, application, captureBroker, connectionId) {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
  const scope = connectionId === 1 ? 'fixture' : `fixture-${connectionId}`
  const app = { appHandle: `${scope}-app`, pid: 9, name: 'Fixture', bundleId: 'test.fixture' }
  const bounds = { x: 40, y: 60, width: 320, height: 200 }
  const window = { windowId: 7, pid: 9, appName: 'Fixture', title: 'CUA fixture', bounds, isOnScreen: true, onCurrentSpace: true }
  const axlessWindow = { ...window, windowId: 8, title: 'AXless canvas' }
  const transformedWindow = { ...window, windowId: 9, title: 'Transformed window', bounds: { x: 16, y: 512, width: 131, height: 145 } }
  const screenshotConfig = new URL('./fixture-screenshot.json', import.meta.url)
  const customScreenshot = existsSync(screenshotConfig) ? JSON.parse(readFileSync(screenshotConfig, 'utf8')) : undefined
  const snapshots = new Map()
  const methods = ['getCapabilities', 'listApps', 'getApp', 'activate', 'show', 'listWindows', 'getState', 'hover', 'click', 'setValue', 'typeText', 'paste', 'pressKey', 'scroll', 'drag', 'screenshot']
  let acquired = false
  let generation = 0
  let observationChanged = false
  let malformedScreenshot = false
  function refuse(code, message) { throw Object.assign(new Error(message), { code }) }
  function call(requestId, method, params) {
    record('call', { requestId, method, params })
    if (method === 'getCapabilities') return { platform: 'macos', sessionLocked: false, permissions: { accessibility: true, screenRecording: true }, methods, coordinateSpace: 'window-points', browser: false }
    if (method === 'listApps') return [{ pid: app.pid, name: app.name, bundleId: app.bundleId }]
    if (method === 'getApp') {
      if (params.selector === 'Denied Fixture' || params.selector === 'Revocable Fixture') {
        const denied = params.selector === 'Denied Fixture'
        return { appHandle: denied ? 'denied-app' : 'revoked-app', pid: 17, name: params.selector,
          authorization: { id: (denied ? 'b' : 'c').repeat(64), name: params.selector,
            executablePath: denied ? '/fixture/denied' : '/fixture/revocable', persistable: false } }
      }
      if (!['Fixture', 'test.fixture', '9'].includes(params.selector)) refuse('APP_NOT_FOUND', 'Select the running Fixture application')
      acquired = true
      return { ...app, authorization: {"id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "name": "Fixture", "executablePath": "/fixture/app", "persistable": true} }
    }
    if (!acquired || params.appHandle !== app.appHandle) refuse('APP_NOT_FOUND', 'Acquire an application in this helper first')
    if (method === 'show') return { dispatched: true, verified: false, windowId: params.windowId ?? window.windowId, foregroundChanged: false }
    if (method === 'activate') {
      const before = { frontPid: application.frontPid, focusedWindowId: window.windowId, frontWindowId: application.frontWindowId, frontWindowPid: application.frontPid }
      const activationRequested = application.frontPid !== app.pid
      if (activationRequested) {
        application.frontPid = app.pid
        application.frontWindowId = window.windowId
      }
      const after = { frontPid: application.frontPid, focusedWindowId: window.windowId, frontWindowId: application.frontWindowId, frontWindowPid: application.frontPid }
      return { dispatched: true, verified: false, foreground: {
        requestId, operation: 'activate', targetPid: app.pid, targetWindowId: null,
        before, after, activationRequested, raiseRequested: false,
      } }
    }
    if (method === 'listWindows') return [window, axlessWindow]
    if (method === 'getState') {
      snapshots.delete(params.windowId ?? null)
      if (observationChanged) {
        observationChanged = false
        refuse('STALE_SNAPSHOT', 'Accessibility tree changed during observation; read fresh getAXState')
      }
      generation++
      const axless = params.windowId === 8
      const snapshotId = `${scope}-snapshot-${generation}`
      snapshots.set(params.windowId ?? null, { snapshotId, windowId: params.windowId ?? null, axless })
      if (axless) return { appHandle: app.appHandle, pid: 9, windowId: 8, snapshotId,
        tree: '', elements: [], windows: [axlessWindow], truncated: false }
      return { appHandle: app.appHandle, pid: 9, windowId: params.windowId ?? null,
        snapshotId: `${scope}-snapshot-${generation}`, tree: `AX scope=${params.windowId === undefined ? 'application' : 'window'} offsets=UTF-16${params.details ? ' bounds=global-points' : ''}\n- [0] AXButton "Increment"${params.details ? ' id="increment" actions=["AXPress"] bounds=[60,80,100,20]' : ''}\n- [1] AXTextField valueWritable=true selectionWritable=true value=${JSON.stringify(application.value)} placeholder="Fixture text"\n- AXStaticText "Count: ${application.count}"${application.hovering ? '\n- AXStaticText "Hover information"' : ''}\n- [2] AXMenuBarItem "File"${params.includeMenus ? '\n  - [3] AXMenuItem "Fixture command"' : '\nMenu contents omitted; request includeMenus=true to expand.'}`,
        elements: [{ index: 0, role: 'AXButton', title: 'Increment', value: null, description: null,
          identifier: null, bounds: [60, 80, 100, 20], actions: ['AXPress'], enabled: true }],
        windows: [params.windowId === 9 ? transformedWindow : window], truncated: false }
    }
    if (params.windowId === 9 && ['screenshot', 'hover', 'click', 'scroll', 'drag'].includes(method) && params.elementIndex === undefined) {
      refuse('WINDOW_CHANGED', 'Window display and accessibility bounds disagree. Read fresh state; if unchanged, use AX actions or explicitly restore the window before capture or coordinate input')
    }
    if (method === 'screenshot' && captureBroker.pendingCapture) {
      socket.write(JSON.stringify({ type: 'diagnostic', requestId, stage: 'helper.failed', elapsedMs: 1, errorCode: 'CAPTURE_BUSY' }) + '\n')
      refuse('CAPTURE_BUSY', 'A previous system capture is still pending; other native operations remain available')
    }
    if (method === 'screenshot' && malformedScreenshot) {
      socket.write(JSON.stringify({ type: 'diagnostic', requestId, stage: 'capture-image.begin', elapsedMs: 1 }) + '\ninvalid screenshot response\n')
      return
    }
    if (method === 'screenshot') return customScreenshot
      ? { pixelWidth: customScreenshot.pixelWidth, pixelHeight: customScreenshot.pixelHeight, bounds: customScreenshot.bounds,
        windowId: params.windowId, mimeType: 'image/png', coordinateSpace: 'window-points',
        data: readFileSync(new URL(customScreenshot.file, import.meta.url)).toString('base64') }
      : { windowId: params.windowId, mimeType: 'image/png', data: png, pixelWidth: 1, pixelHeight: 1, bounds, coordinateSpace: 'window-points' }
    if (method === 'click' || method === 'setValue' || method === 'hover') {
      const observed = params.snapshotId === undefined && params.elementIndex === undefined
        ? snapshots.get(params.windowId) ?? snapshots.get(null)
        : [...snapshots.values()].find(snapshot => snapshot.snapshotId === params.snapshotId)
      if (!observed) refuse('STALE_SNAPSHOT', 'Read fresh state before acting')
      if (params.windowId !== undefined && observed.windowId !== null && observed.windowId !== params.windowId) refuse('STALE_SNAPSHOT', 'Snapshot belongs to another window')
      if (observed.axless && params.elementIndex !== undefined) refuse('INVALID_ARGUMENT', 'Element index is absent from the selected snapshot')
      if (method === 'hover') application.hovering = params.elementIndex === 0 || (params.x >= 20 && params.x <= 40)
      else if (method === 'click' && params.windowId === 8) application.visualCount++
      else if (method === 'click') application.count++
      else application.value = params.value
      record('state', { count: application.count, value: application.value, visualCount: application.visualCount })
      return { dispatched: true, verified: false, ...method === 'hover' ? { hoverRoute: 'accessibility', systemPointerMoved: false } : {} }
    }
    if (method === 'pressKey' && params.key === 'Return') observationChanged = true
    // Fixture-only keys simulate a pending system callback and its eventual completion.
    if (method === 'pressKey' && params.key === 'F11') captureBroker.pendingCapture = true
    if (method === 'pressKey' && params.key === 'F10') captureBroker.pendingCapture = false
    if (method === 'pressKey' && params.key === 'F12') malformedScreenshot = true
    if (method === 'pressKey' && params.key === 'F9') { application.frontPid = 42; application.frontWindowId = 99 }
    if (method === 'paste') {
      if (application.frontPid !== app.pid) refuse('PASTE_NOT_CONSUMED', 'Paste command was dispatched, but clipboard data was not requested within the read deadline. Bring the target app to the foreground and focus its text input. Inspect the contents before deciding whether to retry; a delayed paste may still run.')
      application.value += params.text
      return { dispatched: true, verified: false }
    }
    if (method === 'typeText') application.value += params.text
    else if (!['pressKey', 'scroll', 'drag'].includes(method)) refuse('UNSUPPORTED_OPERATION', method)
    return { dispatched: true, verified: false }
  }
  return call
}
