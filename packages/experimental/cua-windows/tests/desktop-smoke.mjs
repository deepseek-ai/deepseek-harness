/** Real Windows acceptance against private fixture windows; no existing document is modified. */
// TODO: migrate this old window-RPC smoke (discoverWindows/prepareWindows/prepareLaunch) to the listApps/getApp facade before running it again.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { Duplex } from 'node:stream'
import { release } from 'node:os'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const wsl = process.platform === 'linux' && (process.env.WSL_DISTRO_NAME || release().toLowerCase().includes('microsoft'))
assert(process.platform === 'win32' || wsl, 'Run with native Windows Node or WSL on an interactive Windows desktop')
const [helperFile, fixtureFile, outputFile] = process.argv.slice(2).map(path => resolve(path))
assert(helperFile && fixtureFile && outputFile, 'Expected helper, fixture, and evidence file paths')
const resources = []
const results = []

function lines(stream) {
  const reader = createInterface({ input: stream })
  const iterator = reader[Symbol.asyncIterator]()
  return async () => {
    const result = await iterator.next()
    assert(!result.done, 'The native stream ended before a response')
    return JSON.parse(result.value)
  }
}

function child(file, args = []) {
  const process = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const exit = once(process, 'exit')
  const read = args.includes('--bridge') ? undefined : lines(process.stdout)
  process.stderr.pipe(globalThis.process.stderr)
  const resource = { process, exit, read }
  resources.push(resource)
  return resource
}

async function checked(name, operation) {
  const start = performance.now()
  const detail = await operation()
  results.push({ name, elapsedMs: Math.round(performance.now() - start), detail })
  console.log(JSON.stringify(results.at(-1)))
  return detail
}

const deadline = setTimeout(() => {
  console.error('Desktop smoke exceeded its 90-second deadline')
  process.exitCode = 1
  for (const resource of resources) resource.process.kill()
}, 90_000)
let socket
let bridge
try {
  const fixture = child(fixtureFile)
  const initial = await fixture.read()
  const inspect = async command => { fixture.process.stdin.write(command + '\n'); return await fixture.read() }
  const sentinel = child(fixtureFile)
  const sentinelReady = await sentinel.read()
  const cover = async () => {
    await inspect(`allow:${sentinelReady.pid}`)
    sentinel.process.stdin.write('focus\n')
    const focused = await sentinel.read()
    assert.equal(focused.foreground, focused.window, 'The sentinel needs foreground access')
    return await inspect('inspect')
  }
  await cover()
  const runtimeKey = createHash('sha256').update(await readFile(helperFile)).digest('hex')
  const instanceId = randomUUID().replaceAll('-', '')
  const helper = child(helperFile, ['--serve', '--instance-id', instanceId, '--runtime-key', runtimeKey, '--connect-timeout-ms', '10000', '--grace-ms', '3000'])
  const other = child(helperFile, ['--serve', '--instance-id', randomUUID().replaceAll('-', ''), '--runtime-key', runtimeKey, '--connect-timeout-ms', '10000', '--grace-ms', '3000'])
  const [ready] = await checked('Concurrent Host connectors share one desktop service', async () => {
    const pair = await Promise.all([helper.read(), other.read()])
    assert.equal(pair[0].pid, pair[1].pid)
    assert.equal(pair[0].instanceId, pair[1].instanceId)
    return pair
  })
  assert.equal(ready.runtimeKey, runtimeKey)
  if (wsl) {
    bridge = child(helperFile, ['--bridge', '--runtime-key', runtimeKey, '--connect-timeout-ms', '10000', '--grace-ms', '3000'])
    socket = Duplex.from({ readable: bridge.process.stdout, writable: bridge.process.stdin })
    socket.once('end', () => { socket?.end() })
  } else {
    socket = createConnection(ready.endpoint)
    await once(socket, 'connect')
  }
  const read = lines(socket)
  const exchange = async value => { socket.write(JSON.stringify(value) + '\n'); return await read() }
  const hello = await exchange({ type: 'hello', protocol: 1, runtimeKey, config: {
    maxRequestBytes: 1_048_576, maxResponseBytes: 33_554_432, axTimeoutMs: 5000, textEventIntervalMs: 0,
    screenshotTimeoutMs: 10000, timeoutMs: 15000, graceMs: 3000, pollIntervalMs: 25, maxClickHoldMs: 1000,
  } })
  assert.equal(hello.instanceId, ready.instanceId)
  other.process.stdin.end()
  assert.deepEqual(await other.exit, [0, null])
  let sequence = 0
  const request = async (method, params = {}) => {
    const response = await exchange({ id: String(++sequence), method, params })
    if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code })
    return response.result
  }
  await checked('AppsFolder discovery and launch reach the Settings window', async () => {
    const entries = await request('findApps', { query: 'immersivecontrolpanel', maxAppMatches: 20 })
    const entry = entries.find(entry => entry.kind === 'shell')
    assert(entry, 'AppsFolder must expose the system Settings entry')
    const prepared = await request('prepareLaunch', { target: entry.id })
    assert.equal(prepared.authorization.persistable, false)
    assert.deepEqual(await request('dispatchLaunch', { appHandle: prepared.appHandle }), { dispatched: true, verified: false })
    await assert.rejects(request('dispatchLaunch', { appHandle: prepared.appHandle }), { code: 'LAUNCH_ALREADY_DISPATCHED' })
    const until = performance.now() + 10000
    let target
    do {
      target = (await request('discoverWindows')).find(window => window.title === entry.displayName)
      assert(performance.now() < until, 'Settings did not expose a selectable window')
      if (!target) await delay(25)
    } while (!target)
    const [selected] = await request('prepareWindows', { ids: [target.windowId] })
    const observed = await request('getState', { appHandle: selected.appHandle, windowId: target.windowId, maxElements: 100, maxDepth: 20 })
    assert.equal(observed.windowId, target.windowId)
    assert(observed.tree.length > 0)
    return { entry: entry.id, window: target.title, axLength: observed.tree.length }
  })
  await checked('An explicit executable path dispatches independently of Shell discovery', async () => {
    const prepared = await request('prepareLaunch', { target: 'C:\\Windows\\System32\\notepad.exe' })
    assert.equal(prepared.authorization.persistable, false)
    assert.deepEqual(await request('dispatchLaunch', { appHandle: prepared.appHandle }), { dispatched: true, verified: false })
    return { target: prepared.authorization.executablePath }
  })
  const windows = await request('discoverWindows')
  const selected = windows.filter(window => window.pid === initial.pid && window.title === 'DSH CUA owned test window')
  assert.equal(selected.length, 1)
  assert.equal(selected[0].appName, 'dsh-cua-desktop-fixture')
  const windowId = selected[0].windowId
  const [app] = await request('prepareWindows', { ids: [windowId] })
  const appHandle = app.appHandle
  const state = () => request('getState', { appHandle, windowId, maxElements: 100, maxDepth: 20, details: true })
  const baseline = await cover()
  let observation = await checked('UIA observation without foreground change', async () => {
    const result = await state()
    const after = await inspect('inspect')
    assert.equal(after.foreground, baseline.foreground)
    assert.deepEqual(after.cursor, baseline.cursor)
    return result
  })
  const index = (text) => {
    const row = observation.tree.split('\n').find(row => row.includes(text))
    assert(row, `Missing UIA row for ${text}`)
    const match = row.match(/\[(\d+)\]/)
    assert(match, `Missing actionable index for ${text}`)
    return Number(match[1])
  }
  await checked('Background UIA value and invoke affect the target', async () => {
    const valueResult = await request('setValue', { appHandle, snapshotId: observation.snapshotId, elementIndex: index('CUA test text'), value: '你好 😀 Windows' })
    const valued = await inspect('inspect')
    assert.equal(typeof valueResult.foregroundChanged, 'boolean')
    const clickResult = await request('click', { appHandle, snapshotId: observation.snapshotId, elementIndex: index('Record click') })
    const after = await inspect('inspect')
    assert.equal(after.text, '你好 😀 Windows')
    assert.equal(after.clicks, 1)
    // UIA providers can activate after dispatch returns; later observations are separate samples.
    assert.equal(typeof clickResult.foregroundChanged, 'boolean')
    assert.deepEqual(after.cursor, baseline.cursor)
    return { valueResult, clickResult, foregroundBefore: baseline.foreground, foregroundAfterValue: valued.foreground, after }
  })
  for (const command of ['minimize', 'hide']) {
    await checked(`show restores a ${command} window without activation`, async () => {
      const foreground = (await cover()).foreground
      const hidden = await inspect(command)
      assert(command === 'minimize' ? hidden.minimized : !hidden.visible)
      const restored = await request('show', { appHandle, windowId })
      assert.equal(restored.windowId, windowId)
      const until = performance.now() + 5000
      let current
      do {
        current = await inspect('inspect')
        assert(performance.now() < until, 'show did not restore the window')
      } while (current.minimized || !current.visible)
      assert.equal(current.foreground, foreground)
      observation = await state()
      return { restored, state: current }
    })
  }
  const covered = await cover()
  await checked('Window capture without foreground change', async () => {
    const capture = await request('screenshot', { appHandle, windowId })
    const after = await inspect('inspect')
    assert.equal(after.foreground, covered.foreground)
    assert.deepEqual(after.cursor, covered.cursor)
    assert(capture.pixelWidth > 0 && capture.pixelHeight > 0)
    assert(Buffer.from(capture.data, 'base64').subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
    return { width: capture.pixelWidth, height: capture.pixelHeight, bounds: capture.bounds }
  })
  await checked('Background global input refuses before typing', async () => {
    const before = await inspect('inspect')
    assert.notEqual(before.foreground, before.window, 'Fixture must be in the background for this check')
    await assert.rejects(request('typeText', { appHandle, text: 'MUST NOT TYPE' }), { code: 'FOREGROUND_REQUIRED' })
    assert.equal((await inspect('inspect')).text, before.text)
  })
  await checked('Explicit fixture focus permits Unicode input', async () => {
    sentinel.process.stdin.write(`allow:${initial.pid}\n`)
    assert.equal((await sentinel.read()).allowed, true)
    const focused = await inspect('focus')
    assert.equal(focused.foreground, focused.window)
    await request('pressKey', { appHandle, key: 'Control+a' })
    await request('typeText', { appHandle, text: '实机 😀\r\nsecond line' })
    assert.equal((await inspect('inspect')).text, '实机 😀\r\nsecond line')
  })
  await checked('Paste waits for consumption and updates the focused editor', async () => {
    const previousClipboard = await inspect('clipboard-digest')
    await request('pressKey', { appHandle, key: 'Control+a' })
    await request('paste', { appHandle, text: '剪贴板 😀', format: 'text', maxClipboardBytes: 4_194_304,
      pasteReadTimeoutMs: 1000, maxElements: 100, maxDepth: 20 })
    // Clipboard consumption can precede the editor applying the retrieved text.
    const until = performance.now() + 5000
    while ((await inspect('inspect')).text !== '剪贴板 😀') {
      assert(performance.now() < until, 'The editor did not apply the pasted text')
      await delay(25)
    }
    assert.deepEqual(await inspect('clipboard-digest'), previousClipboard, 'Paste must restore the prior clipboard text')
  })
  observation = await state()
  await checked('Hover remains in place through observation and capture', async () => {
    const result = await request('hover', { appHandle, snapshotId: observation.snapshotId, elementIndex: index('Record click') })
    assert.equal(result.hoverRoute, 'system-pointer')
    const hovered = await inspect('inspect')
    await state()
    await request('screenshot', { appHandle, windowId })
    assert.deepEqual((await inspect('inspect')).cursor, hovered.cursor)
  })
  observation = await state()
  await checked('Cancelled timed click releases its button before replying', async () => {
    const id = String(++sequence)
    socket.write(JSON.stringify({ id, method: 'click', params: {
      appHandle, snapshotId: observation.snapshotId, elementIndex: index('Record click'), holdMs: 1000,
    } }) + '\n')
    const until = performance.now() + 5000
    while ((await inspect('inspect')).buttons !== 'Left') {
      assert(performance.now() < until, 'Timed click never pressed its button')
    }
    socket.write(JSON.stringify({ type: 'cancel', id }) + '\n')
    const cancelled = await read()
    assert.equal(cancelled.error?.code, 'NATIVE_CANCELLED')
    assert.equal((await inspect('inspect')).buttons, 'None')
  })
  await checked('A sibling window in the same process cannot borrow the selected window grant', async () => {
    const sibling = await inspect('sibling')
    assert.equal(sibling.foreground, sibling.window)
    await assert.rejects(request('typeText', { appHandle, text: 'must not arrive' }), { code: 'FOREGROUND_REQUIRED' })
    const entries = await request('discoverWindows')
    const otherWindow = entries.find(window => window.pid === initial.pid && window.title === 'DSH CUA sibling test window')
    assert(otherWindow)
    await assert.rejects(request('getState', { appHandle, windowId: otherWindow.windowId, maxElements: 100, maxDepth: 20 }), { code: 'WINDOW_CHANGED' })
    await inspect('focus')
    return { siblingWindowId: otherWindow.windowId, selectedWindowId: windowId }
  })
  await checked('Resize invalidates coordinates before pointer input', async () => {
    await inspect('resize')
    await assert.rejects(request('click', { appHandle, windowId, x: 20, y: 20 }), { code: 'WINDOW_CHANGED' })
  })
  const closed = once(socket, 'close')
  await checked('Agent cleanup returns an explicit acknowledgement before EOF', async () => {
    assert.deepEqual(await exchange({ type: 'close' }), { type: 'closed' })
    await closed
    if (bridge) assert.deepEqual(await bridge.exit, [0, null])
  })
  socket = undefined
  helper.process.stdin.end()
  assert.deepEqual(await helper.exit, [0, null])
  fixture.process.stdin.write('close\n')
  assert.deepEqual(await fixture.exit, [0, null])
  sentinel.process.stdin.write('close\n')
  assert.deepEqual(await sentinel.exit, [0, null])
} finally {
  socket?.destroy()
  for (const resource of resources) {
    resource.process.stdin.end()
    if (resource.process.exitCode === null && resource.process.signalCode === null) resource.process.kill()
  }
  await Promise.allSettled(resources.map(resource => resource.exit))
  clearTimeout(deadline)
  await writeFile(outputFile, JSON.stringify({ platform: process.platform, environment: wsl ? 'wsl' : 'windows', results }, null, 2) + '\n')
}
