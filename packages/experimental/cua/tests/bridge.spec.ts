/** Retained app objects use fresh execution bindings while tool results own image admission. */
import { Buffer } from 'node:buffer'
import { expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { connectCua } from '../src/bridge.ts'
import type { CuaToolBinding } from '../src/bridge.ts'
import type { CuaCapabilities, CuaElementId, CuaOperation } from '../src/types.ts'

/** Element ids are opaque strings; these fixtures use the macOS decimal form. */
const element = (id: string): CuaElementId => brandString<CuaElementId>(id)

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
const capabilities: CuaCapabilities = {
  platform: 'macos', systemPointer: true, permissions: { accessibility: true, screenRecording: true }, appLevelAccessibility: true,
  keyboard: ['app'], sessionLocked: false, methods: ['getCapabilities', 'getApp', 'getState', 'screenshot'],
  coordinateSpace: 'screenshot-pixels', browser: false,
}
const selected = { appHandle: 'app-17', pid: 17, name: 'Editor', running: true }
const bounds = { x: 0, y: 0, width: 640, height: 480 }
const snapshot = {
  appHandle: 'app-17', windowId: null, snapshotId: 'snapshot-1', tree: '0 button', truncated: false,
  windows: [{ windowId: 23, appName: 'Editor', title: 'Document', bounds, isOnScreen: true, onCurrentSpace: null }],
}

it('uses the current tool binding when a retained app is called by another execution', async () => {
  const first = vi.fn(async (operation: CuaOperation): Promise<JsonValue> => {
    if (operation.method === 'getCapabilities') return capabilities
    if (operation.method === 'getApp') return selected
    if (operation.method === 'getState') return { ...snapshot, windowId: operation.params.windowId ?? null }
    return snapshot
  })
  let current: CuaToolBinding = first
  const text = vi.fn()
  const cua = connectCua(() => current, text)
  const app = await cua.getApp('Editor')
  const window = await app.getWindow(23)
  const second = vi.fn(async (): Promise<JsonValue> => ({ dispatched: true }))
  current = second

  await expect(window.click(element('0'))).resolves.toEqual({ dispatched: true })
  expect(first).toHaveBeenCalledTimes(4)
  expect(second).toHaveBeenCalledWith({ method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-1', elementId: '0', windowId: 23 } })
  expect(text).not.toHaveBeenCalled()
  current = first
  await app.getAccessibilityTree()
  expect(text).toHaveBeenCalledWith('0 button')
})

it('propagates a denied action without retrying it', async () => {
  const denial = new Error('Action denied by the user')
  const tool = vi.fn(async (): Promise<JsonValue> => { throw denial })
  const cua = connectCua(() => tool)
  await expect(cua.getApp('Editor')).rejects.toBe(denial)
  expect(tool).toHaveBeenCalledTimes(1)
})

it('supports callers that retain observations without a text callback', async () => {
  const cua = connectCua(() => async () => [{ pid: 17, name: 'Editor' }])
  await expect(cua.listApps()).resolves.toEqual([{ id: '17', displayName: 'Editor', isRunning: true, pid: 17 }])
})

it.each([null, 'text only', { content: [{ type: 'text', text: '{}' }] }])('rejects an unusable tool result %j', async (result) => {
  const cua = connectCua(() => async () => result)
  await expect(cua.getState()).rejects.toThrow()
})

it('returns screenshot bytes and metadata with one image-bearing tool call and no image text output', async () => {
  const tool = vi.fn(async (operation: CuaOperation): Promise<JsonValue> => {
    if (operation.method === 'getCapabilities') return capabilities
    if (operation.method === 'getApp') return selected
    if (operation.method === 'getState') return { ...snapshot, windowId: operation.params.windowId ?? null }
    return {
      mimeType: 'image/png', data: PNG, pixelWidth: 1, pixelHeight: 1, windowId: 23, bounds, coordinateSpace: 'screenshot-pixels',
    }
  })
  const text = vi.fn()
  const app = await connectCua(() => tool, text).getApp('Editor')
  const window = await app.getWindow(23)
  text.mockClear()

  expect(await window.getScreenshot()).toEqual({ bytes: Uint8Array.from(Buffer.from(PNG, 'base64')), mimeType: 'image/png', pixelWidth: 1, pixelHeight: 1, windowId: 23 })
  expect(tool.mock.calls.map(([operation]) => operation.method)).toEqual(['getCapabilities', 'getApp', 'getState', 'getState', 'screenshot'])
  expect(text).not.toHaveBeenCalled()
})
