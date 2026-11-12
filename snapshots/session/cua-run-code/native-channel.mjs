/** Native byte-stream fixture for CUA program composition and recorded replay. */
import { PassThrough, Writable } from 'node:stream'
import { finished } from 'node:stream/promises'

export const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'

/**
 * @param selectorPid Process ID accepted by getApp, when the fixture supports PID selection.
 * @returns An isolated desktop substitute and its observable native requests.
 */
export function createNativeFixture(selectorPid) {
  const calls = []
  const events = []
  const state = { count: 0, openedChannels: 0, closedChannels: 0 }
  let nextHeldClick
  const bounds = { x: 40, y: 60, width: 320, height: 200 }
  const window = { windowId: '7', appName: 'Fixture', title: 'CUA fixture', bounds, isOnScreen: true, onCurrentSpace: true }

  function createChannel() {
    state.openedChannels++
    const stdout = new PassThrough()
    let acquired = false
    let generation = 0
    let observed
    let heldCallId
    function dispatch(method, params) {
      if (method === 'getCapabilities') return { sessionLocked: false, permissions: { accessibility: true, screenRecording: true } }
      if (method === 'listApps') return [{ id: 'test.fixture', name: 'Fixture', isRunning: true, pid: selectorPid ?? 4 }]
      if (method === 'getApp') {
        if (params.selector !== 'test.fixture' && (selectorPid === undefined || params.selector !== String(selectorPid))) {
          throw new Error('Unknown fixture application selector')
        }
        acquired = true
        return { appHandle: 'fixture-app', name: 'Fixture', bundleId: 'test.fixture', running: true,
          authorization: { id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app', persistable: true } }
      }
      if (!acquired || params.appHandle !== 'fixture-app') throw new Error('Acquire the application before using its handle')
      if (method === 'listWindows') return [window]
      if (method === 'getState') {
        observed = `fixture-snapshot-${++generation}`
        return { appHandle: 'fixture-app', windowId: params.windowId ?? null, snapshotId: observed,
          tree: `- [0] AXButton "Increment"\n- AXStaticText "Count: ${state.count}"`, windows: [window], truncated: false }
      }
      if (method === 'click') {
        if (params.snapshotId !== observed || params.elementId !== '0') throw new Error('Use the latest Increment element')
        state.count++
        return { dispatched: true }
      }
      if (method === 'screenshot') return { windowId: params.windowId, mimeType: 'image/png', data: png,
        pixelWidth: 1, pixelHeight: 1, bounds, coordinateSpace: 'window-points' }
      throw new Error(`Unexpected native method: ${method}`)
    }
    const stdin = new Writable({ write(chunk, _encoding, callback) {
      try {
        const { type, id, method, params } = JSON.parse(chunk.toString())
        if (type === 'cancel' && id === heldCallId) {
          heldCallId = undefined
          events.push('native-cancelled')
          stdout.write(JSON.stringify({ id, error: { code: 'NATIVE_CANCELLED', message: 'Fixture click cancelled.' } }) + '\n')
        } else {
          calls.push({ id, method, params })
          if (method === 'click' && nextHeldClick !== undefined) {
            heldCallId = id
            const started = nextHeldClick
            nextHeldClick = undefined
            started.resolve()
          } else {
            const result = dispatch(method, params)
            stdout.write(JSON.stringify({ id, result }) + '\n')
          }
        }
        callback()
      } catch (error) { callback(error) }
    } })
    const done = Promise.all([finished(stdin, { cleanup: true }), finished(stdout, { cleanup: true })])
      .then(() => { state.closedChannels++ })
    let closed = false
    return { stdin, stdout, done,
      close() {
        if (closed) return
        closed = true
        events.push('native-close')
        stdin.end()
        stdout.end()
      },
      waitForClose: () => done,
    }
  }
  return { createChannel, calls, events, state,
    holdNextClick() {
      if (nextHeldClick !== undefined) throw new Error('A fixture click is already held')
      nextHeldClick = Promise.withResolvers()
      return nextHeldClick.promise
    },
  }
}
