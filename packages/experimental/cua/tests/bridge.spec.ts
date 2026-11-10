/** Retained app objects use fresh execution bindings while tool results own image admission. */
import { expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { connectCua } from '../src/bridge.ts'
import type { CuaToolBinding } from '../src/bridge.ts'
import type { CuaCapabilities, CuaElementId, CuaOperation } from '../src/types.ts'

/** Element ids are opaque strings; these fixtures use the macOS decimal form. */
const element = (id: string): CuaElementId => brandString<CuaElementId>(id)

const capabilities: CuaCapabilities = {
  platform: 'macos', systemPointer: true, permissions: { accessibility: true, screenRecording: true }, appLevelAccessibility: true,
  keyboard: ['app'], sessionLocked: false, methods: ['getCapabilities', 'getApp', 'getState', 'screenshot'],
  coordinateSpace: 'screenshot-pixels', browser: false,
}
const selected = { appHandle: 'app-17', name: 'Editor', running: true }
const bounds = { x: 0, y: 0, width: 640, height: 480 }
const snapshot = {
  appHandle: 'app-17', windowId: null, snapshotId: 'snapshot-1', tree: '0 button', truncated: false,
  windows: [{ windowId: '23', appName: 'Editor', title: 'Document', bounds, isOnScreen: true, onCurrentSpace: null }],
}

it('uses the current tool binding when a retained app is called by another execution', async () => {
  const first = vi.fn(async (operation: CuaOperation): Promise<JsonValue> => {
    if (operation.method === 'getCapabilities') return capabilities
    if (operation.method === 'getApp') return selected
    if (operation.method === 'getState') return { ...snapshot, windowId: operation.params.windowId ?? null }
    return snapshot
  })
  let current: CuaToolBinding = first
  const cua = connectCua(() => current)
  const app = await cua.getApp('Editor')
  const window = await app.getWindow('23')
  await window.getAccessibilityTree()
  const second = vi.fn(async (): Promise<JsonValue> => ({ dispatched: true }))
  current = second

  await expect(window.click(element('0'))).resolves.toEqual({ dispatched: true })
  expect(first).toHaveBeenCalledTimes(3)
  expect(second).toHaveBeenCalledWith({ method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-1', elementId: '0', windowId: '23' } })
  current = first
  await expect(app.getAccessibilityTree()).resolves.toBe('0 button')
})

it('propagates a denied action without retrying it', async () => {
  const denial = new Error('Action denied by the user')
  const tool = vi.fn(async (): Promise<JsonValue> => { throw denial })
  const cua = connectCua(() => tool)
  await expect(cua.getApp('Editor')).rejects.toBe(denial)
  expect(tool).toHaveBeenCalledTimes(1)
})

it('returns normalized application records', async () => {
  const cua = connectCua(() => async () => [{ id: 'editor-selector', name: 'Editor', isRunning: true }])
  await expect(cua.listApps()).resolves.toEqual([{ id: 'editor-selector', displayName: 'Editor', isRunning: true }])
})

it.each([null, 'text only', { content: [{ type: 'text', text: '{}' }] }])('rejects an unusable tool result %j', async (result) => {
  const cua = connectCua(() => async () => result)
  await expect(cua.getState()).rejects.toThrow()
})

it('returns the program Image unchanged from one screenshot tool call', async () => {
  const image = Object.freeze({ attachmentId: 'sha256:screenshot', path: '/images/screenshot.png', width: 1, height: 1 })
  const tool = vi.fn(async (operation: CuaOperation): Promise<JsonValue> => {
    if (operation.method === 'getCapabilities') return capabilities
    if (operation.method === 'getApp') return selected
    if (operation.method === 'getState') return { ...snapshot, windowId: operation.params.windowId ?? null }
    return image
  })
  const app = await connectCua(() => tool).getApp('Editor')
  const window = await app.getWindow('23')

  expect(await window.getScreenshot()).toBe(image)
  expect(tool.mock.calls.map(([operation]) => operation.method)).toEqual(['getCapabilities', 'getApp', 'screenshot'])
})
